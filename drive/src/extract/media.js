import { RawImage } from "@huggingface/transformers";

export const SAMPLE_RATE = 16000;
export const AUDIO_WINDOW = 30;
const AUDIO_HOP = 25;
const FRAME_INTERVAL = 3;
const MAX_FRAMES = 1200;
const MIN_IMAGE_SIDE = 256;
const MODEL_PIXELS = 1024;
const FRAME_PIXELS = 512;
const THUMB_PIXELS = 320;

export const BUDGET = { photo: 280, page: 280, slide: 280, frame: 70 };

export class Unreadable extends Error {}

function canvas(width, height) {
  const out = new OffscreenCanvas(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  return [out, out.getContext("2d", { willReadFrequently: true })];
}

const fit = (width, height, pixels) => Math.min(1, pixels / Math.max(width, height));

export function rawImage(source, width, height, pixels = MODEL_PIXELS) {
  const scale = fit(width, height, pixels);
  const [out, context] = canvas(width * scale, height * scale);
  context.drawImage(source, 0, 0, out.width, out.height);
  return RawImage.fromCanvas(out);
}

export async function thumbnail(source, width, height) {
  const scale = fit(width, height, THUMB_PIXELS);
  const [out, context] = canvas(width * scale, height * scale);
  context.fillStyle = "#fff";
  context.fillRect(0, 0, out.width, out.height);
  context.drawImage(source, 0, 0, out.width, out.height);
  const blob = await out.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.readAsDataURL(blob);
  });
}

export async function readImage(blob) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    throw new Unreadable("Chrome can't decode this picture format");
  }
  const { width, height } = bitmap;
  if (Math.max(width, height) < MIN_IMAGE_SIDE) {
    bitmap.close();
    return { tooSmall: true, width, height };
  }
  const image = rawImage(bitmap, width, height);
  const thumb = await thumbnail(bitmap, width, height);
  bitmap.close();
  return { image, thumb, width, height };
}

export async function decodeAudio(blob) {
  const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let buffer;
  try {
    buffer = await context.decodeAudioData(await blob.arrayBuffer());
  } catch {
    return null;
  }
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return { samples: mono, duration: buffer.duration };
}

export function audioWindows({ samples, duration }) {
  const windows = [];
  const size = AUDIO_WINDOW * SAMPLE_RATE;
  const hop = AUDIO_HOP * SAMPLE_RATE;
  for (let start = 0; start < samples.length; start += hop) {
    const end = Math.min(start + size, samples.length);
    windows.push({ t: start / SAMPLE_RATE, tEnd: Math.min(end / SAMPLE_RATE, duration), audio: samples.slice(start, end) });
    if (end >= samples.length) break;
  }
  return windows;
}

function averageHash(source, width, height) {
  const [, context] = canvas(8, 8);
  context.drawImage(source, 0, 0, width, height, 0, 0, 8, 8);
  const pixels = context.getImageData(0, 0, 8, 8).data;
  const gray = Array.from({ length: 64 }, (_, i) => pixels[i * 4] + pixels[i * 4 + 1] + pixels[i * 4 + 2]);
  const mean = gray.reduce((a, b) => a + b, 0) / 64;
  return gray.map((value) => (value > mean ? 1 : 0));
}

const hashDistance = (a, b) => a.reduce((sum, bit, i) => sum + (bit !== b[i]), 0);

function seek(video, time) {
  return new Promise((resolve, reject) => {
    const done = () => {
      video.removeEventListener("seeked", done);
      video.removeEventListener("error", failed);
      resolve();
    };
    const failed = () => reject(new Unreadable("Chrome can't decode this video"));
    video.addEventListener("seeked", done);
    video.addEventListener("error", failed);
    video.currentTime = time;
  });
}

export async function openVideo(blob) {
  const url = URL.createObjectURL(blob);
  const video = document.createElement("video");
  video.muted = true;
  video.preload = "auto";
  video.src = url;
  const close = () => {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  };
  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Unreadable("Chrome can't decode this video format"));
    });
  } catch (error) {
    close();
    throw error;
  }
  const { duration, videoWidth: width, videoHeight: height } = video;
  const hasPicture = width > 0 && height > 0 && Number.isFinite(duration);

  async function keyframes() {
    if (!hasPicture) return { frames: [], thumb: null };
    const step = Math.max(FRAME_INTERVAL, duration / MAX_FRAMES);
    const frames = [];
    let lastHash = null;
    let thumb = null;
    for (let time = Math.min(0.5, duration / 2); time < duration; time += step) {
      await seek(video, time);
      thumb ??= await thumbnail(video, width, height);
      const hash = averageHash(video, width, height);
      if (lastHash && hashDistance(hash, lastHash) <= 4) continue;
      lastHash = hash;
      frames.push({ t: time });
    }
    frames.forEach((frame, i) => (frame.tEnd = frames[i + 1]?.t ?? duration));
    return { frames, thumb };
  }

  async function frameAt(time) {
    await seek(video, time);
    return rawImage(video, width, height, FRAME_PIXELS);
  }

  return { duration: Number.isFinite(duration) ? duration : 0, width, height, keyframes, frameAt, close };
}
