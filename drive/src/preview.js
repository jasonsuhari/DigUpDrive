import { engine, element } from "./ui/common.js";
import { download } from "./sources/drive.js";
import { attachmentBlob } from "./sources/gmail.js";
import { openPDF, renderPage } from "./extract/pdf.js";

const params = new URLSearchParams(location.search);
const stage = document.getElementById("stage");

const blobOf = (item) => (item.source === "drive" ? download(item.ref.fileId) : attachmentBlob(item));

async function show() {
  const { item } = await engine("item", { id: params.get("item") });
  if (!item) throw new Error("That file isn't in the index any more.");
  document.title = item.name;
  document.getElementById("title").textContent = item.name;
  document.getElementById("drive-link").href = item.link;
  const blob = await blobOf(item);
  if (item.kind === "pdf") {
    const page = Number(params.get("page") ?? 1);
    const pdf = await openPDF(new Uint8Array(await blob.arrayBuffer()));
    const canvas = await renderPage(pdf, page, 1600);
    const visible = element("canvas", { width: canvas.width, height: canvas.height });
    visible.getContext("2d").drawImage(canvas, 0, 0);
    stage.replaceChildren(element("p", {}, `Page ${page} of ${pdf.numPages}`), visible);
    return;
  }
  const media = element(item.kind === "video" ? "video" : "audio", { controls: true, autoplay: true, src: URL.createObjectURL(blob) });
  media.currentTime = Number(params.get("t") ?? 0);
  stage.replaceChildren(media);
}

show().catch((error) => (stage.textContent = error.message));
