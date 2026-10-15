import { APIS, request, query } from "../google/api.js";
import { docPieces, spreadsheetPieces, presentationPieces, drawingBlob } from "../extract/google.js";
import { pdfPieces } from "../extract/pdf.js";
import { docxPieces, pptxPieces, xlsxPieces, textPieces } from "../extract/office.js";
import { imagePieces, audioPieces, videoPieces } from "../extract/pieces.js";

const FIELDS = [
  "id", "name", "mimeType", "modifiedTime", "version", "size", "parents", "webViewLink", "iconLink", "ownedByMe",
  "driveId", "trashed",
].join(",");

const MiB = 1024 * 1024;
const MAX_BYTES = { image: 50 * MiB, pdf: 300 * MiB, audio: 300 * MiB, video: 500 * MiB, docx: 50 * MiB, pptx: 100 * MiB, xlsx: 50 * MiB, text: 20 * MiB };

const GOOGLE = "application/vnd.google-apps.";
const BY_MIME = {
  [`${GOOGLE}document`]: "doc",
  [`${GOOGLE}spreadsheet`]: "sheet",
  [`${GOOGLE}presentation`]: "slides",
  [`${GOOGLE}drawing`]: "drawing",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/json": "text",
  "application/rtf": "text",
  "text/rtf": "text",
};

export const FOLDER = `${GOOGLE}folder`;
const SKIPPED = new Set([FOLDER, `${GOOGLE}shortcut`]);

export function readerOf(mimeType) {
  if (BY_MIME[mimeType]) return BY_MIME[mimeType];
  const family = mimeType.split("/")[0];
  if (["image", "audio", "video"].includes(family)) return family;
  if (family === "text") return "text";
  return "other";
}

const KIND = { doc: "doc", docx: "doc", text: "doc", sheet: "sheet", xlsx: "sheet", slides: "slides", pptx: "slides", drawing: "image" };
export const kindOf = (mimeType) => KIND[readerOf(mimeType)] ?? readerOf(mimeType);

export function wanted(file, settings, tree) {
  if (file.trashed || SKIPPED.has(file.mimeType)) return false;
  if (settings.folders.length) return tree.isInside(file, settings.folders);
  if (file.driveId) return settings.sharedDrives;
  return file.ownedByMe || settings.sharedWithMe;
}

function listParams(settings) {
  return settings.sharedDrives
    ? { corpora: "allDrives", includeItemsFromAllDrives: true, supportsAllDrives: true }
    : { corpora: "user" };
}

export async function startPageToken(settings) {
  const { startPageToken } = await request(
    `${APIS.drive}/drive/v3/changes/startPageToken?${query({ supportsAllDrives: settings.sharedDrives })}`,
  );
  return startPageToken;
}

export async function listFiles(settings, onPage) {
  const files = [];
  let pageToken;
  do {
    const page = await request(
      `${APIS.drive}/drive/v3/files?${query({
        ...listParams(settings),
        q: "trashed = false",
        pageSize: 1000,
        pageToken,
        fields: `nextPageToken,files(${FIELDS})`,
      })}`,
    );
    files.push(...page.files);
    onPage?.(files.length);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return files;
}

export async function listChanges(settings, pageToken) {
  const changes = [];
  let next = pageToken;
  let newStartPageToken;
  do {
    const page = await request(
      `${APIS.drive}/drive/v3/changes?${query({
        pageToken: next,
        pageSize: 1000,
        includeRemoved: true,
        supportsAllDrives: settings.sharedDrives,
        includeItemsFromAllDrives: settings.sharedDrives,
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))`,
      })}`,
    );
    changes.push(...page.changes);
    next = page.nextPageToken;
    newStartPageToken = page.newStartPageToken ?? newStartPageToken;
  } while (next);
  return { changes, pageToken: newStartPageToken };
}

export function folderTree(folders) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const paths = new Map();
  const ancestors = (id) => {
    const out = [];
    for (let at = id; at && byId.has(at) && !out.includes(at); at = byId.get(at).parents?.[0]) out.push(at);
    return out;
  };
  const path = (id) => {
    if (!paths.has(id)) paths.set(id, ancestors(id).reverse().map((at) => byId.get(at).name).join(" / "));
    return paths.get(id);
  };
  return {
    pathOf: (file) => (file.parents?.[0] ? path(file.parents[0]) : ""),
    isInside: (file, roots) => (file.parents ?? []).some((parent) => ancestors(parent).some((id) => roots.includes(id)) || roots.includes(parent)),
  };
}

export function toItem(file, tree) {
  return {
    id: `drive:${file.id}`,
    source: "drive",
    ref: { fileId: file.id },
    kind: kindOf(file.mimeType),
    mimeType: file.mimeType,
    name: file.name,
    path: tree.pathOf(file),
    modified: Date.parse(file.modifiedTime),
    version: String(file.version ?? file.modifiedTime),
    size: Number(file.size ?? 0),
    link: file.webViewLink,
    icon: file.iconLink,
  };
}

export const download = (fileId) => request(`${APIS.drive}/drive/v3/files/${fileId}?alt=media`, { as: "blob" });

export async function readBlob(reader, mimeType, blob) {
  switch (reader) {
    case "image": return imagePieces(blob);
    case "pdf": return pdfPieces(blob);
    case "audio": return audioPieces(blob);
    case "video": return videoPieces(blob);
    case "docx": return docxPieces(blob);
    case "pptx": return pptxPieces(blob);
    case "xlsx": return xlsxPieces(blob);
    case "text": return textPieces(blob, mimeType);
    default: return { pieces: [] };
  }
}

export async function readDriveItem(item) {
  const reader = readerOf(item.mimeType);
  const { fileId } = item.ref;
  switch (reader) {
    case "doc": return docPieces(fileId);
    case "sheet": return spreadsheetPieces(fileId);
    case "slides": return presentationPieces(fileId);
    case "drawing": return imagePieces(await drawingBlob(fileId));
    case "other": return { pieces: [], detail: "found by name only" };
  }
  if (item.size > MAX_BYTES[reader]) return { pieces: [], detail: "too big to read in the browser; found by name only" };
  return readBlob(reader, item.mimeType, await download(fileId));
}

export async function account() {
  const { user } = await request(`${APIS.drive}/drive/v3/about?${query({ fields: "user(emailAddress)" })}`);
  return user.emailAddress;
}
