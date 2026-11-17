import {
  applyHomography,
  beginTrack,
  fitSimilarity,
  normalize,
  plausible,
  refitHomography,
  repetitive,
  stepTrack,
  strongCorners,
  type GrayFrame,
  type Mat3,
  type TrackState,
} from "./track";

// Finds where an earlier read's keyframe is in a new view, from any distance along the shelf, so
// walking back brings that read's labels back without reading it again. The tracker itself only
// follows small motions from a good guess; this supplies the guess and the tracker confirms it.

const MAX_CORNERS = 300;
const CELL = 20;
const STRIDE = 2;
const BORDER = 16;
const RADIUS = 12;
const BITS = 256;
const WORDS = BITS / 32;
// Bits that may differ between a corner and its match, and how much better than the runner-up the
// best match must be. Spines repeat, so an ambiguous match is dropped rather than guessed.
const MAX_DISTANCE = 64;
const RATIO = 0.8;
const INLIER_PX = 3;
const TRIALS = 300;
const MIN_INLIERS = 20;
// The tracker's confirmed pose may correct the descriptor fit, but only by this much anywhere.
const AGREE_PX = 8;
const MAX_TRIES = 6;

export type Description = { width: number; height: number; count: number; xy: Float32Array; bits: Uint32Array };
export type KeyEntry = { width: number; height: number; gray: Uint8Array; description: Description };
export type Relocation = { captureId: string; h: Mat3; state: TrackState };

// BRIEF pairs, drawn once from a fixed seed so every keyframe and view compare the same pixels.
const PAIRS = (() => {
  let seed = 0x2545f491;
  const random = () => (seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296;
  // Roughly normal with a spread of 5 px over a 25 px patch, as BRIEF samples.
  const offset = () => Math.max(-RADIUS, Math.min(RADIUS, Math.round((random() + random() + random() + random() - 2) * 8.66)));
  const out = new Int8Array(BITS * 4);
  for (let i = 0; i < BITS; i++) {
    do {
      for (let k = 0; k < 4; k++) out[i * 4 + k] = offset();
    } while (out[i * 4] === out[i * 4 + 2] && out[i * 4 + 1] === out[i * 4 + 3]);
  }
  return out;
})();

function boxBlur(gray: Float32Array, width: number, height: number) {
  const across = new Float32Array(gray.length);
  const out = new Float32Array(gray.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += gray[y * width + Math.min(width - 1, Math.max(0, x + k))];
      across[y * width + x] = sum / 5;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -2; k <= 2; k++) sum += across[Math.min(height - 1, Math.max(0, y + k)) * width + x];
      out[y * width + x] = sum / 5;
    }
  }
  return out;
}

export function describe(frame: GrayFrame): Description {
  const { gray, width, height } = frame;
  const corners = strongCorners(gray, width, height, MAX_CORNERS, CELL, STRIDE)
    .filter(({ x, y }) => x >= BORDER && y >= BORDER && x < width - BORDER && y < height - BORDER);
  const smooth = boxBlur(gray, width, height);
  const xy = new Float32Array(corners.length * 2);
  const bits = new Uint32Array(corners.length * WORDS);
  corners.forEach(({ x, y }, n) => {
    xy[2 * n] = x;
    xy[2 * n + 1] = y;
    const base = y * width + x;
    for (let i = 0; i < BITS; i++) {
      const a = smooth[base + PAIRS[4 * i + 1] * width + PAIRS[4 * i]];
      const b = smooth[base + PAIRS[4 * i + 3] * width + PAIRS[4 * i + 2]];
      if (a < b) bits[n * WORDS + (i >>> 5)] |= 1 << (i & 31);
    }
  });
  return { width, height, count: corners.length, xy, bits };
}

function popcount(value: number) {
  let v = value - ((value >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

/** Corner pairs from the keyframe (`src`) to the view (`dst`), one per view corner. */
export function matchDescriptions(key: Description, view: Description) {
  const chosen = new Map<number, { from: number; distance: number }>();
  for (let i = 0; i < key.count; i++) {
    let best = BITS + 1;
    let second = BITS + 1;
    let at = -1;
    for (let j = 0; j < view.count; j++) {
      let distance = 0;
      for (let w = 0; w < WORDS && distance < second; w++) distance += popcount(key.bits[i * WORDS + w] ^ view.bits[j * WORDS + w]);
      if (distance < best) {
        second = best;
        best = distance;
        at = j;
      } else if (distance < second) second = distance;
    }
    if (at < 0 || best > MAX_DISTANCE || best >= RATIO * second) continue;
    const held = chosen.get(at);
    if (!held || best < held.distance) chosen.set(at, { from: i, distance: best });
  }
  const src: [number, number][] = [];
  const dst: [number, number][] = [];
  for (const [j, { from }] of chosen) {
    src.push([key.xy[2 * from], key.xy[2 * from + 1]]);
    dst.push([view.xy[2 * j], view.xy[2 * j + 1]]);
  }
  return { src, dst };
}

/** Grey rounded to 8 bits, so a keyframe rebuilt from storage is the same frame the tracker began on. */
export function quantize(frame: GrayFrame): GrayFrame {
  const gray = new Float32Array(frame.gray.length);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(Math.min(1, Math.max(0, frame.gray[i])) * 255) / 255;
  return { gray, width: frame.width, height: frame.height };
}

export function keyEntry(frame: GrayFrame, description = describe(frame)): KeyEntry {
  const gray = new Uint8Array(frame.gray.length);
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(Math.min(1, Math.max(0, frame.gray[i])) * 255);
  return { width: frame.width, height: frame.height, gray, description };
}

function entryFrame(entry: KeyEntry): GrayFrame {
  const gray = new Float32Array(entry.gray.length);
  for (let i = 0; i < gray.length; i++) gray[i] = entry.gray[i] / 255;
  return { gray, width: entry.width, height: entry.height };
}

function agree(a: Mat3, b: Mat3, width: number, height: number, limit: number) {
  for (const gx of [0.15, 0.5, 0.85]) {
    for (const gy of [0.15, 0.5, 0.85]) {
      const p = applyHomography(a, gx * width, gy * height);
      const q = applyHomography(b, gx * width, gy * height);
      if (!(Math.hypot(p.x - q.x, p.y - q.y) <= limit)) return false;
    }
  }
  return true;
}

/**
 * The keyframe-to-view homography, and the tracker state resumed on the view, or null. The
 * descriptor fit only proposes a pose: one tracker step from that pose must accept it under every
 * rule a normal step meets, look-alike spines included.
 */
export function relocateTo(entry: KeyEntry, view: GrayFrame, viewDescription: Description, t: number): Omit<Relocation, "captureId"> | null {
  if (entry.width !== view.width || entry.height !== view.height) return null;
  const { src, dst } = matchDescriptions(entry.description, viewDescription);
  if (src.length < MIN_INLIERS) return null;
  const fit = fitSimilarity(src, dst, INLIER_PX, TRIALS);
  if (!fit || fit.inliers < MIN_INLIERS) return null;
  const inSrc = src.filter((_, i) => fit.mask[i]);
  const inDst = dst.filter((_, i) => fit.mask[i]);
  const refit = refitHomography(inSrc, inDst);
  const guess = refit && refit.every(Number.isFinite) && agree(normalize(refit), fit.h, view.width, view.height, AGREE_PX)
    ? normalize(refit)
    : fit.h;
  if (!plausible(guess, view.width, view.height)) return null;
  const begun = beginTrack(entryFrame(entry), t - 1);
  // A run of identical spines looks the same a few spines along, so where the view is can't be told.
  if (!begun.state || repetitive(begun.state)) return null;
  // A velocity of the whole guess over 1 ms makes the tracker's prediction exactly the guess.
  const step = stepTrack({ ...begun.state, velocity: { h: guess, dt: 1 } }, view, { t });
  if (!step.homography || !agree(step.homography, guess, view.width, view.height, AGREE_PX)) return null;
  return { h: step.homography, state: { ...step.state, velocity: null } };
}

/** Tries the candidates in order and returns the first that relocates. */
export function relocate(library: ReadonlyMap<string, KeyEntry>, view: GrayFrame, candidates: readonly string[], t: number, viewDescription = describe(view)): Relocation | null {
  let tried = 0;
  for (const captureId of candidates) {
    const entry = library.get(captureId);
    if (!entry) continue;
    if (++tried > MAX_TRIES) break;
    const found = relocateTo(entry, view, viewDescription, t);
    if (found) return { captureId, ...found };
  }
  return null;
}
