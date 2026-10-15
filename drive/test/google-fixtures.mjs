import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const token = readFileSync(process.env.DIGUP_WRITE_TOKEN_FILE ?? "/tmp/digup-write-token", "utf8").trim();
const FOLDER_NAME = "DigUp test";

async function call(method, url, body, { raw = false, type = "application/json" } = {}) {
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "content-type": type } : {}) },
    body: body && type === "application/json" ? JSON.stringify(body) : body,
  });
  if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${await response.text()}`);
  return raw ? response : response.json();
}

const drive = "https://www.googleapis.com/drive/v3";
const folder = await call("POST", `${drive}/files`, { name: FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" });
const into = (id) => call("PATCH", `${drive}/files/${id}?addParents=${folder.id}&removeParents=root`, {});

const sections = [
  ["Kickoff", "HEADING_1", "The project kickoff happens in Lisbon in March. We agree on scope, owners and the demo date with the whole team."],
  ["Risks", "HEADING_1", "Our biggest risk is the supplier of titanium bolts, who warned that deliveries could slip by six weeks because of a furnace repair."],
  ["Mitigation", "HEADING_2", "We qualify a second bolt vendor near Osaka so production keeps moving if the first supplier is late."],
  ["Budget", "HEADING_1", "Travel is capped at twelve thousand euros. Anything above needs sign-off from finance."],
];
const doc = await call("POST", "https://docs.googleapis.com/v1/documents", { title: "DigUp test plan" });
let text = "";
const styles = [];
for (const [heading, style, body] of sections) {
  const start = text.length + 1;
  text += `${heading}\n`;
  styles.push({ start, end: text.length + 1, style });
  text += `${body}\n`;
}
await call("POST", `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
  requests: [
    { insertText: { location: { index: 1 }, text } },
    ...styles.map(({ start, end, style }) => ({
      updateParagraphStyle: { range: { startIndex: start, endIndex: end }, paragraphStyle: { namedStyleType: style }, fields: "namedStyleType" },
    })),
  ],
});
let secondTab = null;
try {
  const reply = await call("POST", `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    requests: [{ addDocumentTab: { tabProperties: { title: "Field notes" } } }],
  });
  secondTab = reply.replies[0].addDocumentTab.tabProperties.tabId;
  await call("POST", `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`, {
    requests: [{ insertText: { location: { index: 1, tabId: secondTab }, text: "Field notes\nA heron stood on one leg in the reservoir while we measured water clarity.\n" } }],
  });
} catch (error) {
  console.log(`no second doc tab: ${error.message.slice(0, 200)}`);
}
await into(doc.documentId);

const equipment = [["Item", "Supplier", "Cost (EUR)", "Ordered"]];
for (let row = 2; row <= 150; row++) equipment.push([`Pipette tips box ${row}`, "LabCo", String(20 + (row % 7)), "2026-09-01"]);
equipment[119] = ["Refrigerated centrifuge for blood samples", "Eppendorf", "18450", "2026-09-30"];
const sheet = await call("POST", "https://sheets.googleapis.com/v4/spreadsheets", {
  properties: { title: "DigUp test budget" },
  sheets: [{ properties: { title: "Travel" } }, { properties: { title: "Equipment" } }, { properties: { title: "Notes" } }],
});
const gids = Object.fromEntries(sheet.sheets.map((tab) => [tab.properties.title, tab.properties.sheetId]));
await call("POST", `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values:batchUpdate`, {
  valueInputOption: "RAW",
  data: [
    { range: "Travel!A1", values: [["Trip", "Who", "Cost (EUR)"], ["Flight to Lisbon for kickoff", "Ana", "420"], ["Hotel near the Lisbon office", "Ana", "780"], ["Train from Porto", "Rui", "35"]] },
    { range: "Equipment!A1", values: equipment },
    { range: "Notes!A1", values: [["Remember to renew the cold storage maintenance contract before winter."]] },
  ],
});
await into(sheet.spreadsheetId);

const deck = await call("POST", "https://slides.googleapis.com/v1/presentations", { title: "DigUp test deck" });
const slideIds = ["digup_s1", "digup_s2", "digup_s3", "digup_s4"];
await call("POST", `https://slides.googleapis.com/v1/presentations/${deck.presentationId}:batchUpdate`, {
  requests: [
    ...slideIds.map((objectId) => ({ createSlide: { objectId, slideLayoutReference: { predefinedLayout: "BLANK" } } })),
    { createShape: { objectId: "digup_t1", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "digup_s1", size: { width: { magnitude: 6e6, unit: "EMU" }, height: { magnitude: 1e6, unit: "EMU" } } } } },
    { insertText: { objectId: "digup_t1", text: "Quarterly review: revenue grew twenty percent, driven by strong sales in Europe" } },
    { createShape: { objectId: "digup_t2", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "digup_s2", size: { width: { magnitude: 6e6, unit: "EMU" }, height: { magnitude: 1e6, unit: "EMU" } } } } },
    { insertText: { objectId: "digup_t2", text: "Hiring plan: two data engineers and one designer next quarter" } },
    { createImage: { objectId: "digup_i3", url: "https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/cats.jpg", elementProperties: { pageObjectId: "digup_s3" } } },
    { createShape: { objectId: "digup_t4", shapeType: "TEXT_BOX", elementProperties: { pageObjectId: "digup_s4", size: { width: { magnitude: 6e6, unit: "EMU" }, height: { magnitude: 1e6, unit: "EMU" } } } } },
    { insertText: { objectId: "digup_t4", text: "Questions?" } },
  ],
});
const full = await call("GET", `https://slides.googleapis.com/v1/presentations/${deck.presentationId}`);
const notesShape = full.slides.find((slide) => slide.objectId === "digup_s4").slideProperties.notesPage.notesProperties.speakerNotesObjectId;
await call("POST", `https://slides.googleapis.com/v1/presentations/${deck.presentationId}:batchUpdate`, {
  requests: [
    { insertText: { objectId: notesShape, text: "Remember to thank the Helsinki team for the launch party." } },
    { deleteObject: { objectId: full.slides[0].objectId } },
  ],
});
await into(deck.presentationId);

const OFFICE = {
  docx: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc.documentId, "DigUp test plan (Word).docx"],
  xlsx: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", sheet.spreadsheetId, "DigUp test budget (Excel).xlsx"],
  pptx: ["application/vnd.openxmlformats-officedocument.presentationml.presentation", deck.presentationId, "DigUp test deck (PowerPoint).pptx"],
};
const uploads = {};
for (const [kind, [mimeType, id, name]] of Object.entries(OFFICE)) {
  const bytes = Buffer.from(await (await call("GET", `${drive}/files/${id}/export?mimeType=${encodeURIComponent(mimeType)}`, null, { raw: true })).arrayBuffer());
  const boundary = "digup-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name, parents: [folder.id], mimeType })}\r\n--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`),
    bytes,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  uploads[kind] = (await call("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", body, { type: `multipart/related; boundary=${boundary}` })).id;
}

const shot = readFileSync("/tmp/digup-testbed/synthetic/screenshots/shot_flight_booking.png");
{
  const boundary = "digup-boundary";
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\ncontent-type: application/json\r\n\r\n${JSON.stringify({ name: "booking.png", parents: [folder.id] })}\r\n--${boundary}\r\ncontent-type: image/png\r\n\r\n`),
    shot,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  uploads.png = (await call("POST", "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart", body, { type: `multipart/related; boundary=${boundary}` })).id;
}

const fixtures = { folder: folder.id, doc: doc.documentId, secondTab, sheet: sheet.spreadsheetId, gids, deck: deck.presentationId, slideIds, uploads };
mkdirSync("test/results", { recursive: true });
writeFileSync("test/results/google-fixtures.json", JSON.stringify(fixtures, null, 2));
console.log(JSON.stringify(fixtures, null, 2));
