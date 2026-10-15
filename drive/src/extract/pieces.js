import { readImage, decodeAudio, audioWindows, openVideo, BUDGET } from "./media.js";

const clock = (seconds) => {
  const s = Math.floor(seconds);
  const parts = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  return (parts[0] ? `${parts[0]}:${String(parts[1]).padStart(2, "0")}` : `${parts[1]}`) + `:${String(parts[2]).padStart(2, "0")}`;
};

export async function imagePieces(blob) {
  const read = await readImage(blob);
  if (read.tooSmall) return { pieces: [], detail: "smaller than 256 px; found by name only" };
  return {
    pieces: [{ kind: "image", loc: null, label: null, image: read.image, budget: BUDGET.photo }],
    thumb: read.thumb,
    info: { width: read.width, height: read.height },
  };
}

function soundPieces(decoded) {
  return audioWindows(decoded).map(({ t, tEnd, audio }) => ({
    kind: "audio",
    loc: { t, tEnd },
    label: `${clock(t)}–${clock(tEnd)}`,
    audio,
  }));
}

export async function audioPieces(blob) {
  const decoded = await decodeAudio(blob);
  if (!decoded) return { pieces: [], detail: "Chrome can't decode this audio format; found by name only" };
  return { pieces: soundPieces(decoded), info: { duration: decoded.duration } };
}

export async function videoPieces(blob) {
  const video = await openVideo(blob);
  try {
    const { frames, thumb } = await video.keyframes();
    const pieces = frames.map(({ t, tEnd }) => ({
      kind: "frame",
      loc: { t, tEnd },
      label: clock(t),
      budget: BUDGET.frame,
      image: () => video.frameAt(t),
    }));
    const sound = await decodeAudio(blob);
    if (sound) pieces.push(...soundPieces(sound));
    return { pieces, thumb, info: { duration: video.duration }, close: video.close };
  } catch (error) {
    video.close();
    throw error;
  }
}
