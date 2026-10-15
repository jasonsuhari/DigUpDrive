import { APIS, request, query } from "../google/api.js";
import { readerOf, kindOf, readBlob } from "./drive.js";
import { chunks } from "../engine/text.js";

const API = () => `${APIS.gmail}/gmail/v1/users/me`;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const SKIPPED_LABELS = new Set(["SPAM", "TRASH", "CHAT"]);

export const profile = () => request(`${API()}/profile`);

export async function listMessages(settings, onPage) {
  const ids = [];
  let pageToken;
  do {
    const page = await request(`${API()}/messages?${query({ q: settings.gmailQuery, maxResults: 500, pageToken })}`);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    onPage?.(ids.length);
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

export async function listHistory(startHistoryId) {
  const added = new Set();
  const deleted = new Set();
  let pageToken;
  let historyId = startHistoryId;
  do {
    const page = await request(
      `${API()}/history?${query({ startHistoryId, pageToken, historyTypes: "messageAdded", maxResults: 500 })}` +
        "&historyTypes=messageDeleted",
    );
    for (const entry of page.history ?? []) {
      for (const { message } of entry.messagesAdded ?? []) {
        if (!message.labelIds?.some((label) => SKIPPED_LABELS.has(label))) added.add(message.id);
      }
      for (const { message } of entry.messagesDeleted ?? []) deleted.add(message.id);
    }
    historyId = page.historyId ?? historyId;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return { added: [...added].filter((id) => !deleted.has(id)), deleted: [...deleted], historyId };
}

export const messageItem = (id) => ({
  id: `gmail:${id}`,
  source: "gmail",
  ref: { messageId: id },
  kind: "email",
  mimeType: "message/rfc822",
  name: "(email)",
  path: "",
  modified: 0,
  version: "1",
  size: 0,
});

const decode = (data) => {
  const binary = atob(data.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};
const decodeText = (data) => new TextDecoder().decode(decode(data));

function walk(part, out = { plain: [], html: [], attachments: [] }) {
  const filename = part.filename;
  if (filename && (part.body?.attachmentId || part.body?.data)) {
    out.attachments.push({ partId: part.partId, filename, mimeType: part.mimeType, size: part.body.size ?? 0, attachmentId: part.body.attachmentId, data: part.body.data });
  } else if (part.mimeType === "text/plain" && part.body?.data) out.plain.push(decodeText(part.body.data));
  else if (part.mimeType === "text/html" && part.body?.data) out.html.push(decodeText(part.body.data));
  for (const child of part.parts ?? []) walk(child, out);
  return out;
}

const header = (message, name) =>
  message.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

const htmlText = (html) => new DOMParser().parseFromString(html, "text/html").body?.innerText ?? "";

export async function readEmail(item, account) {
  const message = await request(`${API()}/messages/${item.ref.messageId}?format=full`);
  const parts = walk(message.payload);
  const body = parts.plain.length ? parts.plain.join("\n") : parts.html.map(htmlText).join("\n");
  const subject = header(message, "Subject") || "(no subject)";
  const from = header(message, "From");
  const to = [header(message, "To"), header(message, "Cc")].filter(Boolean).join(", ");
  const link = `https://mail.google.com/mail/u/${encodeURIComponent(account)}/#all/${message.threadId}`;
  const update = {
    name: subject,
    path: `From ${from}${to ? ` · To ${to}` : ""}`,
    modified: Number(message.internalDate),
    size: message.sizeEstimate ?? 0,
    link,
    ref: { messageId: message.id, threadId: message.threadId },
  };
  const pieces = chunks(body).map((text, index) => ({
    kind: "chunk",
    loc: { chunk: index + 1 },
    label: null,
    title: subject,
    text: `From: ${from}\n${text}`,
  }));
  if (!pieces.length) pieces.push({ kind: "chunk", loc: { chunk: 1 }, label: null, title: subject, text: `From: ${from}\nTo: ${to}` });
  const children = parts.attachments.map((attachment) => ({
    id: `gmail:${message.id}:${attachment.partId}`,
    source: "gmail",
    ref: { messageId: message.id, threadId: message.threadId, attachmentId: attachment.attachmentId, partId: attachment.partId },
    kind: kindOf(attachment.mimeType),
    mimeType: attachment.mimeType,
    name: attachment.filename,
    path: `Attached to "${subject}" · From ${from}`,
    modified: Number(message.internalDate),
    version: "1",
    size: attachment.size,
    link,
    parent: item.id,
  }));
  return { pieces, update, children, info: { attachments: children.length } };
}

export async function attachmentBlob(item) {
  const { messageId, attachmentId, partId } = item.ref;
  const data = attachmentId
    ? (await request(`${API()}/messages/${messageId}/attachments/${attachmentId}`)).data
    : walk((await request(`${API()}/messages/${messageId}?format=full`)).payload).attachments.find((a) => a.partId === partId)?.data;
  return data ? new Blob([decode(data)], { type: item.mimeType }) : null;
}

export async function readAttachment(item) {
  const reader = readerOf(item.mimeType);
  if (["doc", "sheet", "slides", "drawing", "other"].includes(reader)) return { pieces: [], detail: "found by name only" };
  if (item.size > MAX_ATTACHMENT_BYTES) return { pieces: [], detail: "too big to read in the browser; found by name only" };
  const blob = await attachmentBlob(item);
  if (!blob) return { pieces: [], detail: "the attachment is gone" };
  return readBlob(reader, item.mimeType, blob);
}
