const PREVIEWED = new Set(["pdf", "audio", "video"]);

function url(base, params, account, hash = "") {
  const out = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null) out.searchParams.set(key, value);
  if (account) out.searchParams.set("authuser", account);
  return out.toString() + hash;
}

export function openTarget(item, segment, account) {
  const loc = segment?.loc;
  const id = item.ref?.fileId;
  if (item.source === "drive" && loc) {
    if (loc.tab || loc.heading) {
      return url(`https://docs.google.com/document/d/${id}/edit`, { tab: loc.tab }, account, loc.heading ? `#heading=${loc.heading}` : "");
    }
    if (loc.gid !== undefined) {
      const range = loc.range ? `&range=${loc.range}` : "";
      return url(`https://docs.google.com/spreadsheets/d/${id}/edit`, { gid: loc.gid }, account, `#gid=${loc.gid}${range}`);
    }
    if (typeof loc.slide === "string") {
      return url(`https://docs.google.com/presentation/d/${id}/edit`, {}, account, `#slide=id.${loc.slide}`);
    }
  }
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
