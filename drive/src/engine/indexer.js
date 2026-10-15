import * as drive from "../sources/drive.js";
import * as gmail from "../sources/gmail.js";
import { GoogleError } from "../google/api.js";
import { Unreadable } from "../extract/media.js";
import { embedTexts, embedImages, embedAudio, prompts, releaseIndexingModel, VECTOR_VERSION } from "./model.js";
import { hasWords } from "./text.js";
import { getMeta, setMeta, allItems, putItems, removeItems, replaceSegments } from "./store.js";

export const DEFAULT_SETTINGS = {
  drive: true,
  sharedWithMe: false,
  sharedDrives: false,
  gmail: true,
  gmailQuery: "newer_than:1y",
  folders: [],
};

const MAX_EMBED_CHARS = 4000;
const MAX_STORED_CHARS = 20000;
const IMAGES_PER_STEP = 32;

export async function settings() {
  return { ...DEFAULT_SETTINGS, ...(await getMeta("settings")) };
}

const driveScope = (s) => JSON.stringify([s.sharedWithMe, s.sharedDrives, s.folders]);

export class Indexer {
  constructor(searcher, notify) {
    this.searcher = searcher;
    this.notify = notify;
    this.running = null;
    this.paused = false;
    this.status = { phase: "idle" };
  }

  report(status) {
    this.status = { ...this.status, ...status };
    this.notify(this.status);
  }

  run() {
    this.running ??= this.sync()
      .catch((error) => this.report({ phase: "error", error: error.message, signedOut: error instanceof GoogleError && error.status === 401 }))
      .finally(() => (this.running = null));
    return this.running;
  }

  async sync() {
    const current = await settings();
    if ((await getMeta("vectorVersion")) !== VECTOR_VERSION) await this.requeueEverything();
    if (!(await getMeta("account"))) await setMeta("account", await drive.account());
    await this.retryFailed();
    if (current.drive) await this.syncDrive(current);
    else await this.dropSource("drive");
    if (current.gmail) await this.syncGmail(current);
    else await this.dropSource("gmail");
    await this.drain();
    this.report({ phase: "idle", lastSync: Date.now(), current: null });
  }

  async save(items) {
    if (!items.length) return;
    await putItems(items);
    for (const item of items) this.searcher.setItem(item);
  }

  async retryFailed() {
    const failed = [...this.searcher.items.values()].filter((item) => item.state === "failed").map((item) => ({ ...item, state: "pending" }));
    await this.save(failed);
  }

  async requeueEverything() {
    const items = (await allItems()).map((item) => ({ ...item, state: "pending" }));
    await this.save(items);
    await setMeta("vectorVersion", VECTOR_VERSION);
  }

  async dropSource(source) {
    const ids = [...this.searcher.items.values()].filter((item) => item.source === source).map((item) => item.id);
    if (ids.length) await this.remove(ids);
    await setMeta(`${source}.cursor`, null);
  }

  async remove(ids) {
    const parents = new Set(ids);
    const children = [...this.searcher.items.values()].filter((item) => parents.has(item.parent)).map((item) => item.id);
    const doomed = [...new Set([...ids, ...children])];
    const removed = await removeItems(doomed);
    for (const id of doomed) this.searcher.removeItem(id, removed.get(id) ?? []);
  }

  async queue(items) {
    const changed = [];
    for (const item of items) {
      const stored = this.searcher.items.get(item.id);
      if (stored && stored.indexedVersion === item.version && stored.state !== "pending") continue;
      changed.push({ ...stored, ...item, state: "pending", queued: Date.now() });
    }
    await this.save(changed);
    return changed.length;
  }

  async syncDrive(current) {
    const cursor = await getMeta("drive.cursor");
    if (!cursor || cursor.scope !== driveScope(current)) return this.listDrive(current);
    const { changes, pageToken } = await drive.listChanges(current, cursor.pageToken);
    const folders = { ...cursor.folders };
    for (const { file, removed } of changes) {
      if (file?.mimeType !== drive.FOLDER) continue;
      if (removed || file.trashed) delete folders[file.id];
      else folders[file.id] = { id: file.id, name: file.name, parents: file.parents };
    }
    const tree = drive.folderTree(Object.values(folders));
    const removed = [];
    const upserts = [];
    for (const change of changes) {
      if (change.file?.mimeType === drive.FOLDER) continue;
      if (change.removed || !change.file || !drive.wanted(change.file, current, tree)) removed.push(`drive:${change.fileId}`);
      else upserts.push(change.file);
    }
    await this.queue(upserts.map((file) => drive.toItem(file, tree)));
    const gone = [];
    for (const id of removed) if (this.searcher.items.has(id)) gone.push(id);
    if (gone.length) await this.remove(gone);
    await setMeta("drive.cursor", { scope: cursor.scope, pageToken, folders });
  }

  async listDrive(current) {
    this.report({ phase: "listing", source: "drive", listed: 0 });
    const pageToken = await drive.startPageToken(current);
    const files = await drive.listFiles(current, (listed) => this.report({ listed }));
    const folders = files.filter((file) => file.mimeType === drive.FOLDER);
    const tree = drive.folderTree(folders);
    const items = files.filter((file) => drive.wanted(file, current, tree)).map((file) => drive.toItem(file, tree));
    await this.queue(items);
    const keep = new Set(items.map((item) => item.id));
    const stale = [...this.searcher.items.values()].filter((item) => item.source === "drive" && !keep.has(item.id)).map((item) => item.id);
    if (stale.length) await this.remove(stale);
    await setMeta("drive.cursor", {
      scope: driveScope(current),
      pageToken,
      folders: Object.fromEntries(folders.map((folder) => [folder.id, { id: folder.id, name: folder.name, parents: folder.parents }])),
    });
  }

  async syncGmail(current) {
    const cursor = await getMeta("gmail.cursor");
    if (!cursor || cursor.query !== current.gmailQuery) return this.listGmail(current);
    let history;
    try {
      history = await gmail.listHistory(cursor.historyId);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 404) return this.listGmail(current);
      throw error;
    }
    await this.queue(history.added.map(gmail.messageItem));
    const gone = [];
    for (const id of history.deleted) if (this.searcher.items.has(`gmail:${id}`)) gone.push(`gmail:${id}`);
    if (gone.length) await this.remove(gone);
    await setMeta("gmail.cursor", { ...cursor, historyId: history.historyId });
  }

  async listGmail(current) {
    this.report({ phase: "listing", source: "gmail", listed: 0 });
    const { emailAddress, historyId } = await gmail.profile();
    const ids = await gmail.listMessages(current, (listed) => this.report({ listed }));
    const fresh = ids
      .filter((id) => !this.searcher.items.has(`gmail:${id}`))
      .map((id, index) => ({ ...gmail.messageItem(id), state: "pending", queued: index }));
    await this.save(fresh);
    const keep = new Set(ids.map((id) => `gmail:${id}`));
    const stale = [...this.searcher.items.values()].filter((item) => item.source === "gmail" && !item.parent && !keep.has(item.id)).map((item) => item.id);
    if (stale.length) await this.remove(stale);
    await setMeta("gmail.cursor", { query: current.gmailQuery, historyId, account: emailAddress });
  }

  counts() {
    const tally = { total: 0, pending: 0, done: 0, failed: 0 };
    for (const item of this.searcher.items.values()) {
      tally.total++;
      tally[item.state === "pending" ? "pending" : item.state === "failed" ? "failed" : "done"]++;
    }
    return tally;
  }

  next() {
    const pending = [...this.searcher.items.values()].filter((item) => item.state === "pending");
    if (!pending.length) return null;
    const bySource = { drive: [], gmail: [] };
    for (const item of pending) bySource[item.source].push(item);
    bySource.drive.sort((a, b) => b.modified - a.modified);
    bySource.gmail.sort((a, b) => (a.parent ? 0 : 1) - (b.parent ? 0 : 1) || a.queued - b.queued);
    this.turn = this.turn === "drive" ? "gmail" : "drive";
    return (bySource[this.turn][0] ?? bySource.drive[0] ?? bySource.gmail[0]) || null;
  }

  async drain() {
    let item;
    this.report({ phase: "indexing", ...this.counts() });
    while (!this.paused && (item = this.next())) {
      this.report({ current: item.name });
      await this.index(item);
      this.report({ phase: "indexing", ...this.counts() });
    }
    await releaseIndexingModel();
    this.report(this.counts());
  }

  async read(item) {
    if (item.source === "drive") return drive.readDriveItem(item);
    if (item.ref.attachmentId || item.ref.partId) return gmail.readAttachment(item);
    const { account } = (await getMeta("gmail.cursor")) ?? {};
    return gmail.readEmail(item, account);
  }

  async index(item) {
    const started = performance.now();
    let read = { pieces: [] };
    let segments = [];
    let failure = null;
    try {
      read = await this.read(item);
      Object.assign(item, read.update);
      if (read.children?.length) await this.queue(read.children);
      segments = await this.embed(item, read.pieces);
    } catch (error) {
      if (error instanceof GoogleError && error.status === 401) throw error;
      if (error instanceof Unreadable) read = { pieces: [], detail: `${error.message}; found by name only` };
      else failure = error;
      segments = [];
    } finally {
      read.close?.();
    }
    segments.unshift({ kind: "name", modality: null, loc: null, label: null, text: `${item.name} ${item.path ?? ""}`, vec: null });
    const finished = {
      ...item,
      state: failure ? "failed" : "done",
      detail: failure ? failure.message : read.detail ?? read.info?.detail ?? null,
      info: read.info ?? null,
      thumb: read.thumb ?? item.thumb ?? null,
      indexedVersion: item.version,
      seconds: (performance.now() - started) / 1000,
    };
    console.info(
      `indexed ${item.kind} "${item.name}": ${finished.state}, ${segments.length} segments, ${finished.seconds.toFixed(1)} s` +
        (finished.detail ? ` (${finished.detail})` : ""),
    );
    const { removed, written } = await replaceSegments(finished, segments);
    this.searcher.setItem(finished);
    for (const id of removed) this.searcher.removeSegment(id);
    for (const segment of written) this.searcher.addSegment(segment);
  }

  async embed(item, pieces) {
    const title = (piece) => [item.name, piece.title].filter(Boolean).join(" · ");
    const segment = (piece, modality, vec) => ({
      kind: piece.kind,
      modality,
      loc: piece.loc ?? null,
      label: piece.label ?? null,
      text: piece.text ? piece.text.slice(0, MAX_STORED_CHARS) : null,
      vec: vec ? new Float16Array(vec) : null,
    });

    const texts = pieces.filter((piece) => !piece.image && !piece.audio && piece.text);
    const worded = texts.filter((piece) => hasWords(piece.text));
    const textVectors = await embedTexts(worded.map((piece) => prompts.document(title(piece), piece.text.slice(0, MAX_EMBED_CHARS))));
    const vectorOf = new Map(worded.map((piece, i) => [piece, textVectors[i]]));
    const out = texts.map((piece) => segment(piece, "text", vectorOf.get(piece)));

    const images = pieces.filter((piece) => piece.image);
    for (let start = 0; start < images.length; start += IMAGES_PER_STEP) {
      const step = images.slice(start, start + IMAGES_PER_STEP);
      const byBudget = Map.groupBy(step, (piece) => piece.budget);
      for (const [budget, group] of byBudget) {
        const resolved = [];
        for (const piece of group) resolved.push(typeof piece.image === "function" ? await piece.image() : piece.image);
        const vectors = await embedImages(resolved, budget);
        group.forEach((piece, i) => out.push(segment(piece, "image", vectors[i])));
      }
    }

    const sounds = pieces.filter((piece) => piece.audio);
    const soundVectors = await embedAudio(sounds.map((piece) => piece.audio));
    sounds.forEach((piece, i) => out.push(segment(piece, "audio", soundVectors[i])));
    return out;
  }
}
