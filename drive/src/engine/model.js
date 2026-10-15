import { AutoConfig, AutoModel, AutoProcessor, env } from "@huggingface/transformers";

export const MODEL_ID = "onnx-community/embeddinggemma-2-ONNX";
export const DTYPE = { model: "q4", vision_encoder: "q4", audio_encoder: "q8" };
export const DIMENSION = 768;
export const VECTOR_VERSION = `${MODEL_ID}@${JSON.stringify(DTYPE)}`;

// ONNX Runtime WebGPU kernels exceed a GPU dispatch limit above ~2,700 tokens a batch (model card).
const BATCH_TOKENS = 2400;
const AUDIO_TOKENS_PER_SECOND = 25;

env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("ort/");
env.backends.onnx.wasm.numThreads = 1;

export const prompts = {
  query: (text) => `task: search result | query: ${text}`,
  document: (title, text) => `title: ${title?.trim() || "none"} | text: ${text}`,
};

let processor;
const models = { text: null, full: null };
let onProgress = () => {};

export function reportDownloads(callback) {
  onProgress = callback;
}

async function load(which) {
  if (models[which]) return models[which];
  processor ??= await AutoProcessor.from_pretrained(MODEL_ID);
  const config = await AutoConfig.from_pretrained(MODEL_ID);
  if (which === "text") config.vision_config = config.audio_config = null;
  models[which] = await AutoModel.from_pretrained(MODEL_ID, {
    config,
    device: "webgpu",
    dtype: which === "text" ? { model: DTYPE.model } : DTYPE,
    progress_callback: (event) => onProgress(event),
  });
  return models[which];
}

async function run(which, ...inputs) {
  const model = await load(which);
  const { sentence_embedding } = await model(await processor(...inputs));
  const rows = sentence_embedding.dims[0];
  const data = sentence_embedding.data;
  return Array.from({ length: rows }, (_, row) => data.slice(row * DIMENSION, (row + 1) * DIMENSION));
}

function batches(items, cost) {
  const out = [];
  let batch = [];
  let widest = 0;
  for (const item of items) {
    const tokens = cost(item);
    if (batch.length && Math.max(widest, tokens) * (batch.length + 1) > BATCH_TOKENS) {
      out.push(batch);
      batch = [];
      widest = 0;
    }
    batch.push(item);
    widest = Math.max(widest, tokens);
  }
  if (batch.length) out.push(batch);
  return out;
}

const textTokens = (text) => Math.ceil(text.length / 3) + 8;

export async function embedQuery(text) {
  const which = models.full ? "full" : "text";
  const [vector] = await run(which, [prompts.query(text)]);
  return vector;
}

export async function embedTexts(texts) {
  const out = [];
  for (const batch of batches(texts, textTokens)) out.push(...(await run("full", batch)));
  return out;
}

export async function embedImages(images, budget) {
  await load("full");
  processor.image_processor.max_soft_tokens = budget;
  const out = [];
  for (const batch of batches(images, () => budget)) {
    out.push(...(await run("full", null, batch.map((image) => [image]))));
  }
  return out;
}

export async function embedAudio(clips) {
  const out = [];
  const cost = (clip) => Math.ceil((clip.length / 16000) * AUDIO_TOKENS_PER_SECOND) + 4;
  for (const batch of batches(clips, cost)) out.push(...(await run("full", null, null, batch)));
  return out;
}

export async function releaseIndexingModel() {
  await models.full?.dispose();
  models.full = null;
}

export async function releaseQueryModel() {
  await models.text?.dispose();
  models.text = null;
}

export const loaded = () => ({ text: !!models.text, full: !!models.full });
