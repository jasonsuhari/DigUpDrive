import { Searcher } from "./engine/search.js";
import { Indexer, settings } from "./engine/indexer.js";
import { embedQuery, releaseQueryModel, reportDownloads, loaded } from "./engine/model.js";
import { getMeta, setMeta, getItem, itemsInState, wipe } from "./engine/store.js";
import { openTarget } from "./engine/links.js";

const QUERY_MODEL_IDLE_MS = 5 * 60 * 1000;

const broadcast = (message) => chrome.runtime.sendMessage({ to: "ui", ...message }).catch(() => {});

const downloads = new Map();
reportDownloads((event) => {
  if (event.status === "progress" && event.total > 1e6) downloads.set(event.file, { loaded: event.loaded, total: event.total });
  if (event.status === "done") downloads.delete(event.file);
  const all = [...downloads.values()];
  broadcast({
    op: "download",
    download: all.length ? { loaded: all.reduce((a, d) => a + d.loaded, 0), total: all.reduce((a, d) => a + d.total, 0) } : null,
  });
});

const searcher = await new Searcher().load();
const indexer = new Indexer(searcher, (status) => broadcast({ op: "status", status }));

let idleTimer;
function touchQueryModel() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(releaseQueryModel, QUERY_MODEL_IDLE_MS);
}

const handlers = {
  async search({ q, kinds, prefixLast }) {
    const text = q.trim();
    if (!text) return { hits: [] };
    const started = performance.now();
    const vector = await embedQuery(text);
    touchQueryModel();
    const hits = await searcher.search(text, vector, { kinds, prefixLast });
    const account = await getMeta("account");
    return {
      ms: Math.round(performance.now() - started),
      hits: hits.map((hit) => ({ ...hit, open: openTarget(hit.item, hit.segment, account) })),
    };
  },
  async words({ q, kinds }) {
    const hits = await searcher.search(q.trim(), null, { kinds, prefixLast: true });
    const account = await getMeta("account");
    return { hits: hits.map((hit) => ({ ...hit, open: openTarget(hit.item, hit.segment, account) })) };
  },
  async status() {
    return {
      status: indexer.status,
      settings: await settings(),
      vectors: searcher.vectorCount,
      items: searcher.items.size,
      pending: Object.fromEntries(
        ["drive", "gmail"].map((source) => [source, [...searcher.items.values()].filter((item) => item.source === source && item.state === "pending").length]),
      ),
      models: loaded(),
      failed: (await itemsInState("failed")).slice(0, 50).map((item) => ({ name: item.name, detail: item.detail, kind: item.kind })),
    };
  },
  async sync() {
    indexer.paused = false;
    indexer.run();
    return { started: true };
  },
  async pause() {
    indexer.paused = true;
    return { paused: true };
  },
  async saveSettings({ settings: next }) {
    await setMeta("settings", { ...(await settings()), ...next });
    indexer.run();
    return { settings: await settings() };
  },
  async item({ id }) {
    return { item: await getItem(id) };
  },
  async reset() {
    indexer.paused = true;
    await indexer.running;
    await wipe();
    location.reload();
    return { reset: true };
  },
};

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message.to !== "offscreen") return false;
  const handler = handlers[message.op];
  if (!handler) return false;
  handler(message)
    .then(reply, (error) => reply({ error: error.message }));
  return true;
});

broadcast({ op: "ready" });
