import { engine, element, onEngine, KIND_LABELS, formatDate, formatCount, marked } from "./ui/common.js";

const FILTERS = [
  ["all", "All", null],
  ["doc", "Docs", ["doc"]],
  ["sheet", "Sheets", ["sheet"]],
  ["slides", "Slides", ["slides"]],
  ["pdf", "PDFs", ["pdf"]],
  ["media", "Pictures & video", ["image", "video"]],
  ["audio", "Audio", ["audio"]],
  ["email", "Email", ["email"]],
];

const input = document.querySelector("#q");
const list = document.querySelector("#results");
const status = document.querySelector("#status");
const chips = document.querySelector("#filters");
let filter = "all";
let selected = 0;
let hits = [];
let generation = 0;

for (const [key, label] of FILTERS) {
  chips.append(
    element("button", {
      class: key === filter ? "chip on" : "chip",
      "data-key": key,
      onclick: () => {
        filter = key;
        for (const chip of chips.children) chip.classList.toggle("on", chip.dataset.key === key);
        search();
      },
    }, label),
  );
}

const kinds = () => FILTERS.find(([key]) => key === filter)[2];

function thumbnail(item) {
  if (item.thumb) return element("img", { class: "thumb", src: item.thumb, alt: "" });
  if (item.icon) return element("div", { class: "thumb icon" }, element("img", { src: item.icon.replace("/16/", "/64/"), alt: "" }));
  return element("div", { class: "thumb icon" }, KIND_LABELS[item.kind]?.[0] ?? "·");
}

function render(note) {
  list.replaceChildren();
  const strong = hits.filter((hit) => hit.strong);
  const weak = hits.filter((hit) => !hit.strong);
  const row = (hit, index) => {
    const { item, segment } = hit;
    const place = segment?.label;
    const where = item.source === "gmail" ? item.path : item.path ? `Drive · ${item.path}` : "Drive";
    return element(
      "li",
      {
        class: index === selected ? "hit selected" : "hit",
        onclick: (event) => open(hit, event.metaKey || event.ctrlKey),
        onmouseenter: () => select(index, false),
      },
      thumbnail(item),
      element(
        "div",
        { class: "body" },
        element("div", { class: "title" },
          element("span", { class: "name" }, item.name),
          place && element("span", { class: "place" }, place),
        ),
        hit.excerpt && element("div", { class: "excerpt" }, marked(hit.excerpt)),
        element("div", { class: "meta" }, [KIND_LABELS[item.kind], formatDate(item.modified), where].filter(Boolean).join(" · ")),
      ),
    );
  };
  strong.forEach((hit, i) => list.append(row(hit, i)));
  if (weak.length) {
    const details = element("details", { class: "weak" }, element("summary", {}, `${weak.length} weaker matches`));
    const inner = element("ul", {});
    weak.forEach((hit, i) => inner.append(row(hit, strong.length + i)));
    details.append(inner);
    list.append(details);
  }
  if (note) status.textContent = note;
}

function select(index, scroll = true) {
  selected = Math.max(0, Math.min(index, hits.length - 1));
  const rows = list.querySelectorAll(".hit");
  rows.forEach((row, i) => row.classList.toggle("selected", i === selected));
  if (scroll) rows[selected]?.scrollIntoView({ block: "nearest" });
}

function open(hit, inBackground = false) {
  const url = hit.open ?? hit.item.link;
  if (url) chrome.tabs.create({ url, active: !inBackground });
}

async function search() {
  const q = input.value;
  const mine = ++generation;
  if (!q.trim()) {
    hits = [];
    render();
    showProgress();
    return;
  }
  history.replaceState(null, "", `?q=${encodeURIComponent(q)}`);
  try {
    const quick = await engine("words", { q, kinds: kinds() });
    if (mine !== generation) return;
    hits = quick.hits;
    selected = 0;
    render("Searching…");
    const full = await engine("search", { q, kinds: kinds(), prefixLast: true });
    if (mine !== generation) return;
    hits = full.hits;
    selected = 0;
    render(hits.length ? `${hits.length} results · ${full.ms} ms` : "Nothing stands out for that. Try other words.");
  } catch (error) {
    if (mine === generation) status.textContent = error.message;
  }
}

let timer;
input.addEventListener("input", () => {
  clearTimeout(timer);
  timer = setTimeout(search, 120);
});

input.addEventListener("keydown", (event) => {
  if (event.key === "ArrowDown") select(selected + 1);
  else if (event.key === "ArrowUp") select(selected - 1);
  else if (event.key === "Enter" && hits[selected]) open(hits[selected], event.metaKey || event.ctrlKey);
  else return;
  event.preventDefault();
});

async function showProgress() {
  const { status: s, items } = await engine("status");
  if (input.value.trim()) return;
  if (s.signedOut || s.error === "signed out") status.replaceChildren("Not signed in. ", element("a", { href: "options.html", target: "_blank" }, "Set up DigUp"));
  else if (s.phase === "listing") status.textContent = `Listing ${s.source === "gmail" ? "Gmail" : "Drive"}… ${formatCount(s.listed ?? 0)}`;
  else if (s.phase === "indexing") status.textContent = `Reading ${formatCount(s.done)} of ${formatCount(s.total)}${s.current ? ` · ${s.current}` : ""}`;
  else status.textContent = `${formatCount(items)} files and emails`;
}

onEngine("status", () => showProgress());
document.querySelector("#expand").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`popup.html?q=${encodeURIComponent(input.value)}`) });
});
document.querySelector("#settings").addEventListener("click", () => chrome.runtime.openOptionsPage());

if (chrome.extension.getViews({ type: "tab" }).includes(window)) document.body.classList.add("tab");
const initial = new URLSearchParams(location.search).get("q");
if (initial) {
  input.value = initial;
  search();
} else showProgress();
input.focus();
