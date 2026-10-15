import * as pdfjs from "pdfjs-dist";
import { rawImage, thumbnail, BUDGET } from "./media.js";

const MAX_PAGES = 2000;
const MIN_PAGE_TEXT = 200;
const RENDER_PIXELS = 1024;

pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("pdf.worker.min.mjs");
const assets = chrome.runtime.getURL("pdfjs/");

export async function openPDF(data) {
  return pdfjs.getDocument({
    data,
    cMapUrl: `${assets}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assets}standard_fonts/`,
    wasmUrl: `${assets}wasm/`,
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
}

async function render(page, pixels) {
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: pixels / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  // pdf.js schedules "display" renders on requestAnimationFrame, which never fires in a hidden offscreen document.
  await page.render({ canvas, viewport, intent: "print" }).promise;
  return canvas;
}

export async function renderPage(pdf, number, pixels = RENDER_PIXELS) {
  return render(await pdf.getPage(number), pixels);
}

async function pageText(page) {
  const content = await page.getTextContent();
  return content.items.map((item) => item.str + (item.hasEOL ? "\n" : "")).join("").trim();
}

export async function pdfPieces(blob) {
  const pdf = await openPDF(new Uint8Array(await blob.arrayBuffer()));
  const total = pdf.numPages;
  const pieces = [];
  for (let number = 1; number <= Math.min(total, MAX_PAGES); number++) {
    const page = await pdf.getPage(number);
    const text = await pageText(page);
    const loc = { page: number };
    const label = `Page ${number}`;
    if (text.length >= MIN_PAGE_TEXT) {
      pieces.push({ kind: "page", loc, label, text });
    } else {
      pieces.push({
        kind: "pageImage",
        loc,
        label,
        text,
        budget: BUDGET.page,
        image: async () => {
          const canvas = await render(await pdf.getPage(number), RENDER_PIXELS);
          return rawImage(canvas, canvas.width, canvas.height);
        },
      });
    }
    page.cleanup();
  }
  const cover = await renderPage(pdf, 1, 640);
  const thumb = await thumbnail(cover, cover.width, cover.height);
  return {
    pieces,
    thumb,
    info: { pages: total, ...(total > MAX_PAGES ? { detail: `the first ${MAX_PAGES} of ${total} pages` } : {}) },
    close: () => pdf.loadingTask.destroy(),
  };
}
