import { unzipSync, strFromU8 } from "fflate";
import { chunks } from "../engine/text.js";
import { sheetPieces } from "./sheets.js";
import { Unreadable } from "./media.js";

const xml = (bytes) => new DOMParser().parseFromString(strFromU8(bytes), "application/xml");
const local = (node, name) => [...node.getElementsByTagName("*")].filter((child) => child.localName === name);

async function unzip(blob) {
  try {
    return unzipSync(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    throw new Unreadable("not a readable Office file");
  }
}

export function sectionPieces(sections, describe) {
  return sections.flatMap((section) => {
    const { loc, label } = describe(section);
    return chunks(section.text).map((text) => ({ kind: "chunk", loc, label, title: label, text }));
  });
}

export async function docxPieces(blob) {
  const files = await unzip(blob);
  const document = files["word/document.xml"];
  if (!document) throw new Unreadable("not a readable Word file");
  const sections = [{ heading: null, text: "" }];
  for (const paragraph of local(xml(document), "p")) {
    const style = local(paragraph, "pStyle")[0]?.getAttribute("w:val") ?? "";
    const text = local(paragraph, "t").map((node) => node.textContent).join("");
    if (!text.trim()) continue;
    if (/^(Heading|Title)/i.test(style)) sections.push({ heading: text.trim(), text: `${text}\n` });
    else sections.at(-1).text += `${text}\n`;
  }
  const written = sections.filter((section) => section.text.trim());
  return { pieces: sectionPieces(written, (section) => ({ loc: { heading: section.heading }, label: section.heading })) };
}

export async function pptxPieces(blob) {
  const files = await unzip(blob);
  const presentation = files["ppt/presentation.xml"];
  const relations = files["ppt/_rels/presentation.xml.rels"];
  if (!presentation || !relations) throw new Unreadable("not a readable PowerPoint file");
  const targets = Object.fromEntries(
    local(xml(relations), "Relationship").map((node) => [node.getAttribute("Id"), node.getAttribute("Target")]),
  );
  const order = local(xml(presentation), "sldId").map((node) => targets[node.getAttribute("r:id")]);
  const pieces = [];
  order.forEach((target, index) => {
    const path = `ppt/${target.replace(/^\/?ppt\//, "")}`;
    const slide = files[path];
    if (!slide) return;
    const paragraphs = local(xml(slide), "p").map((p) => local(p, "t").map((t) => t.textContent).join(""));
    const notesTarget = files[path.replace("slides/", "slides/_rels/") + ".rels"];
    let notes = "";
    if (notesTarget) {
      const note = local(xml(notesTarget), "Relationship").find((node) => node.getAttribute("Type").endsWith("/notesSlide"));
      const notesFile = note && files[`ppt/${note.getAttribute("Target").replace(/^\.\.\//, "")}`];
      if (notesFile) notes = local(xml(notesFile), "t").map((t) => t.textContent).join(" ");
    }
    const text = [...paragraphs.filter((p) => p.trim()), notes && `Speaker notes: ${notes}`].filter(Boolean).join("\n");
    const number = index + 1;
    pieces.push({ kind: "slide", loc: { slide: number }, label: `Slide ${number}`, title: paragraphs.find((p) => p.trim()), text });
  });
  return { pieces, info: { slides: order.length } };
}

const columnIndex = (letters) => [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;

export async function xlsxPieces(blob) {
  const files = await unzip(blob);
  const workbook = files["xl/workbook.xml"];
  const relations = files["xl/_rels/workbook.xml.rels"];
  if (!workbook || !relations) throw new Unreadable("not a readable Excel file");
  const strings = files["xl/sharedStrings.xml"]
    ? local(xml(files["xl/sharedStrings.xml"]), "si").map((si) => local(si, "t").map((t) => t.textContent).join(""))
    : [];
  const targets = Object.fromEntries(
    local(xml(relations), "Relationship").map((node) => [node.getAttribute("Id"), node.getAttribute("Target")]),
  );
  const tabs = local(xml(workbook), "sheet").map((sheet) => {
    const target = targets[sheet.getAttribute("r:id")] ?? "";
    const file = files[`xl/${target.replace(/^\/?xl\//, "")}`];
    const rows = [];
    if (file) {
      for (const row of local(xml(file), "row")) {
        const values = [];
        for (const cell of local(row, "c")) {
          const reference = cell.getAttribute("r") ?? "";
          const column = columnIndex(reference.replace(/\d+/g, ""));
          const type = cell.getAttribute("t");
          const raw = type === "inlineStr" ? local(cell, "t").map((t) => t.textContent).join("") : local(cell, "v")[0]?.textContent ?? "";
          values[column] = type === "s" ? strings[Number(raw)] ?? "" : raw;
        }
        rows[Number(row.getAttribute("r")) - 1] = Array.from(values, (value) => value ?? "");
      }
    }
    return { title: sheet.getAttribute("name"), rows: Array.from(rows, (row) => row ?? []) };
  });
  return sheetPieces(tabs, (tab) => ({ tab: tab.title }));
}

export async function textPieces(blob, mimeType) {
  let text = await blob.text();
  if (mimeType === "text/html") text = new DOMParser().parseFromString(text, "text/html").body?.innerText ?? "";
  if (mimeType === "application/rtf" || mimeType === "text/rtf") text = rtfText(text);
  return { pieces: chunks(text).map((chunk, index) => ({ kind: "chunk", loc: { chunk: index + 1 }, label: null, text: chunk })) };
}

const RTF_SKIPPED = new Set(["fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer", "listtable", "listoverridetable", "generator", "themedata", "datastore", "latentstyles"]);

function rtfText(rtf) {
  let out = "";
  const skipping = [false];
  for (let i = 0; i < rtf.length; i++) {
    const c = rtf[i];
    if (c === "{") skipping.push(skipping.at(-1));
    else if (c === "}") skipping.length > 1 && skipping.pop();
    else if (c === "\\") {
      const word = /^\\([a-z]+)(-?\d+)? ?|^\\'([0-9a-f]{2})|^\\(.)/i.exec(rtf.slice(i, i + 40));
      if (!word) continue;
      i += word[0].length - 1;
      const [, name, number, hex, symbol] = word;
      if (symbol === "*" || RTF_SKIPPED.has(name)) skipping[skipping.length - 1] = true;
      if (skipping.at(-1)) continue;
      if (name === "par" || name === "line") out += "\n";
      else if (name === "tab") out += "\t";
      else if (name === "u") out += String.fromCharCode((Number(number) + 65536) % 65536);
      else if (hex) out += String.fromCharCode(parseInt(hex, 16));
      else if (symbol && "\\{}".includes(symbol)) out += symbol;
    } else if (!skipping.at(-1) && c !== "\r" && c !== "\n") out += c;
  }
  return out;
}
