export const CHUNK_CHARS = 1800;
const CHUNK_OVERLAP = 200;
const EXCERPT_CHARS = 300;

export const normalize = (text) => text.normalize("NFKC").toLowerCase();

const WORD = /[\p{L}\p{N}\p{M}]+/gu;

export const words = (text) => normalize(text).match(WORD) ?? [];

const STOPWORDS = new Set(
  (
    "a an the of in on at to for with and or my me that this these those from about where what which who when is " +
    "was are were be it its some any find show file files photo photos picture image images screenshot screenshots " +
    "video videos pdf document documents recording doc docs sheet sheets spreadsheet slide slides deck presentation " +
    "এবং ও এই সেই একটি আমার থেকে জন্য সাথে মধ্যে কোথায় কোন কী কি যে ছবি স্ক্রিনশট ভিডিও ফাইল পিডিএফ " +
    "في من على الى عن مع هذا هذه ذلك التي الذي اين ما صورة صور لقطة شاشة فيديو ملف مستند"
  ).split(" "),
);

export function terms(query) {
  const seen = new Set();
  return words(query).filter((word) => [...word].length >= 2 && !STOPWORDS.has(word) && !seen.has(word) && seen.add(word));
}

export const isLookup = (queryTerms) =>
  queryTerms.length > 0 &&
  queryTerms.every((term) => /\p{N}/u.test(term) && (/\p{L}/u.test(term) || term.length >= 4));

const KIND_WORDS = {
  screenshot: "image", screenshots: "image", photo: "image", photos: "image", picture: "image", pictures: "image",
  image: "image", images: "image", pdf: "pdf", pdfs: "pdf", paper: "pdf", papers: "pdf",
  document: "doc", documents: "doc", doc: "doc", docs: "doc", note: "doc", notes: "doc",
  sheet: "sheet", sheets: "sheet", spreadsheet: "sheet", spreadsheets: "sheet", table: "sheet",
  slide: "slides", slides: "slides", deck: "slides", presentation: "slides", presentations: "slides",
  video: "video", videos: "video", clip: "video", movie: "video",
  audio: "audio", song: "audio", podcast: "audio", voice: "audio", sound: "audio", recording: "audio",
};

export const kindHints = (query) => new Set(words(query).map((word) => KIND_WORDS[word]).filter(Boolean));

export const hasWords = (text) => {
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const others = text.match(/[^\p{L}\s]/gu)?.length ?? 0;
  return letters > 0 && letters * 4 >= others;
};

export function chunks(text, limit = Infinity) {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  const out = [];
  let start = 0;
  while (start < clean.length && out.length < limit) {
    let end = Math.min(start + CHUNK_CHARS, clean.length);
    if (end < clean.length) {
      const space = clean.lastIndexOf(" ", end);
      if (space > start + CHUNK_CHARS / 2) end = space;
    }
    const chunk = clean.slice(start, end).trim();
    if (chunk) out.push(chunk);
    if (end >= clean.length) break;
    let next = Math.max(end - CHUNK_OVERLAP, start + 1);
    const space = clean.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    start = next;
  }
  return out;
}

export const excerpt = (text) => {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > EXCERPT_CHARS ? `${clean.slice(0, EXCERPT_CHARS)}…` : clean;
};

export function snippet(text, queryTerms) {
  const clean = text.replace(/\s+/g, " ");
  const lower = normalize(clean);
  let first = -1;
  for (const term of queryTerms) {
    const at = lower.indexOf(term);
    if (at !== -1 && (first === -1 || at < first)) first = at;
  }
  if (first === -1) return null;
  const start = Math.max(0, first - 80);
  let out = clean.slice(start, start + EXCERPT_CHARS);
  for (const term of [...queryTerms].sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![«\\p{L}])(${escape(term)}[\\p{L}\\p{N}]*)`, "giu"), "«$1»");
  }
  return (start > 0 ? "…" : "") + out + (start + EXCERPT_CHARS < clean.length ? "…" : "");
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
