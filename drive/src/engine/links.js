const PREVIEWED = new Set(["pdf", "audio", "video"]);

function url(base, params, account, hash = "") {
  const out = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) out.searchParams.set(key, value);
  if (account) out.searchParams.set("authuser", account);
  return out.toString() + hash;
}

const GOOGLE = "application/vnd.google-apps.";

const DEEP_LINKS = {
  [`${GOOGLE}document`]: (id, loc, account) =>
    url(`https://docs.google.com/document/d/${id}/edit`, { tab: loc.tab }, account, loc.heading ? `#heading=${loc.heading}` : ""),
  [`${GOOGLE}spreadsheet`]: (id, loc, account) =>
    url(`https://docs.google.com/spreadsheets/d/${id}/edit`, { gid: loc.gid }, account, `#gid=${loc.gid}${loc.range ? `&range=${loc.range}` : ""}`),
  [`${GOOGLE}presentation`]: (id, loc, account) =>
    url(`https://docs.google.com/presentation/d/${id}/edit`, {}, account, `#slide=id.${loc.slide}`),
};

export function openTarget(item, segment, account) {
  const loc = segment?.loc;
  const deepLink = DEEP_LINKS[item.mimeType];
  if (deepLink && loc) return deepLink(item.ref.fileId, loc, account);
  if (PREVIEWED.has(item.kind) && (loc?.page || loc?.t !== undefined)) return previewURL(item, loc);
  if (!item.link) return null;
  return item.source === "drive" ? url(item.link, {}, account) : item.link;
}

export function previewURL(item, loc) {
  const params = new URLSearchParams({ item: item.id });
  if (loc?.page) params.set("page", loc.page);
  if (loc?.t !== undefined) params.set("t", loc.t.toFixed(1));
  return chrome.runtime.getURL(`preview.html?${params}`);
}

export const folderId = (text) => /\/folders\/([\w-]+)/.exec(text)?.[1] ?? text.trim();
