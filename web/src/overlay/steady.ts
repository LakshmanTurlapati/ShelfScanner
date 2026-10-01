import type { GrayFrame } from "./track";

// Mean brightness change per pixel (0..1) between samples below which the view counts as still.
const MAX_DIFF = 0.015;
const HOLD_MS = 500;
// A sampling gap this long (a hidden tab, a stalled camera) says nothing about the time between.
const MAX_GAP_MS = 1000;
// Brightness spread (standard deviation) below which the view is blank or too dark to read.
const MIN_SPREAD = 0.03;
// Both measures below are relative to the frame's own contrast, so dim light and flat shelves pass.
// Measured on frames drawn from a <video> at 96px: shelves have about 0.2 of their pixels on an edge.
const MIN_TEXTURE = 0.05;
// Laplacian variance over brightness variance: sharp shelves about 0.65 at any exposure, an 8px blur
// on a 1080px frame about 0.12, a 16px blur about 0.02.
const MIN_SHARPNESS = 0.1;

export type SteadyReading = { steady: boolean; diff: number; texture: number; sharpness: number };

export function frameDiff(a: GrayFrame, b: GrayFrame) {
  let sum = 0;
  for (let i = 0; i < a.gray.length; i++) sum += Math.abs(a.gray[i] - b.gray[i]);
  return sum / Math.max(1, a.gray.length);
}

function spread(gray: Float32Array) {
  let mean = 0;
  for (const value of gray) mean += value;
  mean /= Math.max(1, gray.length);
  let variance = 0;
  for (const value of gray) variance += (value - mean) ** 2;
  return Math.sqrt(variance / Math.max(1, gray.length));
}

/** Share of pixels whose gradient exceeds the frame's own brightness spread. */
export function texture({ gray, width, height }: GrayFrame) {
  const edge = spread(gray);
  if (edge < MIN_SPREAD) return 0;
  let strong = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + width] - gray[i - width]) > edge) strong += 1;
    }
  }
  return strong / Math.max(1, (width - 2) * (height - 2));
}

/** Variance of the Laplacian relative to the brightness variance. */
export function sharpness({ gray, width, height }: GrayFrame) {
  const contrast = spread(gray);
  if (contrast < MIN_SPREAD) return 0;
  let sum = 0;
  let squares = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const laplacian = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += laplacian;
      squares += laplacian * laplacian;
    }
  }
  const count = Math.max(1, (width - 2) * (height - 2));
  return (squares / count - (sum / count) ** 2) / contrast ** 2;
}

export function createSteadyDetector() {
  let previous: { frame: GrayFrame; at: number } | null = null;
  let calmSince: number | null = null;
  return {
    feed(frame: GrayFrame, now: number): SteadyReading {
      const last = previous;
      const comparable = last && last.frame.width === frame.width && last.frame.height === frame.height && now - last.at <= MAX_GAP_MS;
      const diff = comparable ? frameDiff(last.frame, frame) : 1;
      calmSince = diff < MAX_DIFF ? calmSince ?? last!.at : null;
      previous = { frame, at: now };
      const reading = { diff, texture: texture(frame), sharpness: sharpness(frame) };
      const held = calmSince !== null && now - calmSince >= HOLD_MS;
      return { steady: held && reading.texture >= MIN_TEXTURE && reading.sharpness >= MIN_SHARPNESS, ...reading };
    },
  };
}
