import { CHUNK_CHARS } from "../engine/text.js";

const MAX_ROWS = 20000;

export const columnName = (index) => {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

const rowText = (row) => row.map((cell) => String(cell ?? "").trim()).filter(Boolean).join(" | ");

export function sheetPieces(tabs, tabLoc) {
  const pieces = [];
  for (const tab of tabs) {
    const rows = tab.rows.slice(0, MAX_ROWS);
    const headerIndex = rows.findIndex((row) => rowText(row));
    if (headerIndex === -1) continue;
    const header = rowText(rows[headerIndex]);
    const width = Math.max(...rows.map((row) => row.length));
    let first = null;
    let last = null;
    let body = "";
    const flush = (end) => {
      if (first === null) return;
      const range = `A${first + 1}:${columnName(width - 1)}${end + 1}`;
      pieces.push({
        kind: "rows",
        loc: { ...tabLoc(tab), range },
        label: `${tab.title} · rows ${first + 1}–${end + 1}`,
        title: tab.title,
        text: first === headerIndex ? body : `${header}\n${body}`,
      });
      first = null;
      body = "";
    };
    rows.forEach((row, index) => {
      const text = rowText(row);
      if (!text) return;
      first ??= index;
      last = index;
      body += `${text}\n`;
      if (body.length >= CHUNK_CHARS) flush(index);
    });
    flush(last);
  }
  return { pieces, info: { tabs: tabs.length } };
}
