import { APIS, request, query } from "../google/api.js";
import { sectionPieces } from "./office.js";
import { sheetPieces } from "./sheets.js";
import { readImage, BUDGET } from "./media.js";

const MAX_SLIDE_PICTURES = 300;

const runs = (elements = []) => elements.map((element) => element.textRun?.content ?? "").join("");

function structuralText(content = []) {
  let text = "";
  for (const element of content) {
    if (element.paragraph) text += runs(element.paragraph.elements);
    else if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        text += row.tableCells.map((cell) => structuralText(cell.content).trim()).join(" | ") + "\n";
      }
    }
  }
  return text;
}

function flattenTabs(tabs = []) {
  return tabs.flatMap((tab) => [tab, ...flattenTabs(tab.childTabs)]);
}

export async function docPieces(fileId) {
  const document = await request(`${APIS.docs}/v1/documents/${fileId}?${query({ includeTabsContent: true })}`);
  const tabs = flattenTabs(document.tabs);
  const sections = [];
  for (const tab of tabs) {
    const tabId = tab.tabProperties.tabId;
    const tabTitle = tabs.length > 1 ? tab.tabProperties.title : null;
    let section = { tabId, tabTitle, heading: null, headingId: null, text: "" };
    for (const element of tab.documentTab?.body?.content ?? []) {
      const style = element.paragraph?.paragraphStyle;
      if (style?.headingId && /^(HEADING_\d|TITLE|SUBTITLE)$/.test(style.namedStyleType)) {
        if (section.text.trim()) sections.push(section);
        const heading = runs(element.paragraph.elements).trim();
        section = { tabId, tabTitle, heading, headingId: style.headingId, text: `${heading}\n` };
        continue;
      }
      section.text += structuralText([element]);
    }
    if (section.text.trim()) sections.push(section);
  }
  const pieces = sectionPieces(sections, (section) => ({
    loc: { tab: section.tabId, heading: section.headingId },
    label: [section.tabTitle, section.heading].filter(Boolean).join(" › ") || null,
  }));
  return { pieces, info: { tabs: tabs.length } };
}

export async function spreadsheetPieces(fileId) {
  const meta = await request(
    `${APIS.sheets}/v4/spreadsheets/${fileId}?${query({ fields: "sheets.properties(sheetId,title,sheetType)" })}`,
  );
  const grids = (meta.sheets ?? []).map((sheet) => sheet.properties).filter((tab) => tab.sheetType !== "OBJECT");
  if (!grids.length) return { pieces: [] };
  const params = new URLSearchParams({ valueRenderOption: "FORMATTED_VALUE", majorDimension: "ROWS" });
  for (const tab of grids) params.append("ranges", `'${tab.title.replaceAll("'", "''")}'`);
  const values = await request(`${APIS.sheets}/v4/spreadsheets/${fileId}/values:batchGet?${params}`);
  const tabs = grids.map((tab, index) => ({
    title: tab.title,
    sheetId: tab.sheetId,
    rows: values.valueRanges?.[index]?.values ?? [],
  }));
  return sheetPieces(tabs, (tab) => ({ gid: tab.sheetId }));
}

function shapeText(elements = []) {
  const out = [];
  for (const element of elements) {
    if (element.shape?.text) out.push(runs(element.shape.text.textElements));
    if (element.table) {
      for (const row of element.table.tableRows ?? []) {
        out.push((row.tableCells ?? []).map((cell) => runs(cell.text?.textElements).trim()).join(" | "));
      }
    }
    if (element.elementGroup) out.push(shapeText(element.elementGroup.children));
  }
  return out.map((text) => text.trim()).filter(Boolean).join("\n");
}

export async function presentationPieces(fileId) {
  const deck = await request(`${APIS.slides}/v1/presentations/${fileId}`);
  const slides = deck.slides ?? [];
  const pieces = [];
  slides.forEach((slide, index) => {
    const number = index + 1;
    const text = shapeText(slide.pageElements);
    const notes = shapeText(slide.slideProperties?.notesPage?.pageElements?.filter(
      (element) => element.shape?.placeholder?.type === "BODY",
    ));
    const loc = { slide: slide.objectId, number };
    const label = `Slide ${number}${slide.slideProperties?.isSkipped ? " (skipped)" : ""}`;
    const body = [text, notes && `Speaker notes: ${notes}`].filter(Boolean).join("\n");
    const title = text.split("\n")[0] || null;
    if (body) pieces.push({ kind: "slide", loc, label, title, text: body });
    if (index < MAX_SLIDE_PICTURES) {
      pieces.push({
        kind: "slideImage",
        loc,
        label,
        text: body,
        budget: BUDGET.slide,
        image: async () => (await readImage(await slideThumbnail(fileId, slide.objectId))).image,
      });
    }
  });
  const thumb = slides[0] && (await readImage(await slideThumbnail(fileId, slides[0].objectId))).thumb;
  return { pieces, thumb, info: { slides: slides.length } };
}

const THUMBNAIL_SPACING_MS = 300;
let lastThumbnail = 0;

async function slideThumbnail(fileId, pageId) {
  const wait = lastThumbnail + THUMBNAIL_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastThumbnail = Date.now();
  const { contentUrl } = await request(
    `${APIS.slides}/v1/presentations/${fileId}/pages/${pageId}/thumbnail?${query({
      "thumbnailProperties.thumbnailSize": "MEDIUM",
      "thumbnailProperties.mimeType": "PNG",
    })}`,
    { attempts: 8 },
  );
  const response = await fetch(contentUrl);
  if (!response.ok) throw new Error(`slide picture ${response.status}`);
  return response.blob();
}

export async function drawingBlob(fileId) {
  return request(`${APIS.drive}/drive/v3/files/${fileId}/export?${query({ mimeType: "image/png" })}`, { as: "blob" });
}
