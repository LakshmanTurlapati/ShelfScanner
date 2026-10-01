export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export type GrayFrame = { gray: Float32Array; width: number; height: number };

export type Level = { img: Float32Array; w: number; h: number };

export type Pyramid = Level[];

/** The motion `h` that took `dt` milliseconds. */
export type Velocity = { h: Mat3; dt: number };

/**
 * A tracked point in keyframe coordinates; added points were found while the camera moved. `alike` is
 * how far along its row or column the frame it was found in repeats it: Infinity when it repeats
 * nowhere near, 0 when it lies on a straight edge and so repeats everywhere along it.
 */
export type TrackPoint = { kx: number; ky: number; miss: number; added: boolean; alike: number };

export type TrackState = {
  width: number;
  height: number;
  keyframe: Pyramid;
  /** The first `corners` points are the keyframe's own corners. */
  corners: number;
  points: TrackPoint[];
  ref: Pyramid;
  refT: number;
  keyToRef: Mat3;
  velocity: Velocity | null;
};

export type StepResult = {
  state: TrackState;
  steady: boolean;
  status: "tracked" | "unsteady";
  homography: Mat3 | null;
  velocity: Velocity | null;
  inliers: number;
  rms: number;
  reason: string | null;
  /** Nothing trackable matched: no points in view, or too few that still look like their templates. */
  hard: boolean;
};

export type Fit = { h: Mat3; mask: Uint8Array; inliers: number; rms: number };

type Rules = { inliers: number; ratio: number; spread: number; rms: number; corr: number };

const LEVELS = 4;
const MIN_TOP_SIDE = 32;
const RADIUS = 5;
const SIDE = 2 * RADIUS + 1;
const AREA = SIDE * SIDE;
const PATCH = SIDE + 2;
const MAX_ITERATIONS = 10;
const CONVERGED_PX = 0.02;
const MIN_EIGEN = 2e-5;
const MARGIN = RADIUS + 3;

const CELL = 40;
const KEY_CORNERS = 120;
const CORNER_SCORE = 0.002;
const MIN_POINTS = 12;
const REFILL_BELOW = 70;
const REFILL_MAX = 40;
const MAX_POINTS = 250;
const MAX_MISSES = 4;

const FB_MIN_CORR = 0.5;
const FB_MAX_PX = 1;
const PREDICT_MS = 350;
const MAX_PREDICT_FACTOR = 4;
const RETRY_SHIFT_PX = 1.5;

const INLIER_PX = 2;
const RANSAC_TRIALS = 60;
const RANSAC_MIN_TRIALS = 8;
const REFITS = 3;
const SIMILARITY_BELOW = 25;

const STEP: Rules = { inliers: MIN_POINTS, ratio: 0.5, spread: 0.2, rms: 1, corr: 0.65 };
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.33;
const MAX_ROTATION = (15 * Math.PI) / 180;
const MAX_STRETCH = 1.05;

const ANCHOR: Rules = { inliers: 15, ratio: 0.5, spread: 0.15, rms: Infinity, corr: 0.75 };
const ANCHOR_POINTS = 60;
const ANCHOR_MOVE_PX = 6;
const ANCHOR_POINT_CORR = 0.6;
const ANCHOR_AGREE_PX = 30;
// While at least this many keyframe corners are in view, a step resting on fewer inliers than
// CONFIRM_BELOW stands only if the keyframe confirms it.
const CONFIRM_FROM = 30;
const CONFIRM_BELOW = 25;
const RESCUABLE = new Set(["spread", "rms", "correlation"]);

// Look-alikes are searched on the half-size frame with 9x9 patches, from 6 to 120 px away; a repeat
// must be separated from the point by a stretch that does not look like it.
const ALIKE_RADIUS = 4;
const ALIKE_FROM = 3;
const ALIKE_TO = 60;
const ALIKE_CORR = 0.85;
const ALIKE_VALLEY = 0.5;
// Fewer points without a look-alike than this can't vouch for a step. Where they are tried, a pose
// one look-alike off fits almost none of them, while the true one fits more than a quarter as many
// of them as of the look-alikes, even with motion blur.
const DISTINCT_MIN = 6;
const DISTINCT_SHARE = 0.25;
// Where nearly every point has look-alikes, a step stands only if it comes this soon after an
// accepted one, it and the one before each moved less than this fraction of their distance, and
// this share of the points in view fit it.
const ALIKE_GAP_MS = 150;
const ALIKE_STEP = 0.125;
const ALIKE_FIT = 0.8;

export function applyHomography(h: Mat3, x: number, y: number) {
  const w = h[6] * x + h[7] * y + h[8];
  const denom = Math.abs(w) < 1e-8 ? 1e-8 : w;
  return { x: (h[0] * x + h[1] * y + h[2]) / denom, y: (h[3] * x + h[4] * y + h[5]) / denom };
}

export function composeHomography(a: Mat3, b: Mat3): Mat3 {
  const out = Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
    }
  }
  return out as Mat3;
}

function normalize(h: Mat3): Mat3 {
  return Math.abs(h[8]) < 1e-12 ? h : (h.map((value) => value / h[8]) as Mat3);
}

export function invertHomography(h: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, i, k] = h;
  const co0 = e * k - f * i;
  const co1 = f * g - d * k;
  const co2 = d * i - e * g;
  const det = a * co0 + b * co1 + c * co2;
  const s = Math.abs(det) < 1e-15 ? 0 : 1 / det;
  return normalize([
    co0 * s, (c * i - b * k) * s, (b * f - c * e) * s,
    co1 * s, (a * k - c * g) * s, (c * d - a * f) * s,
    co2 * s, (b * g - a * i) * s, (a * e - b * d) * s,
  ]);
}

/** The motion of `velocity` continued for `ms` milliseconds, to first order. */
export function extrapolateHomography(velocity: Velocity, ms: number): Mat3 {
  const factor = velocity.dt > 0 ? ms / velocity.dt : 0;
  const h = normalize(velocity.h);
  return h.map((value, index) => IDENTITY[index] + factor * (value - IDENTITY[index])) as Mat3;
}

function similarity(pts: [number, number][]) {
  const cx = pts.reduce((sum, point) => sum + point[0], 0) / pts.length;
  const cy = pts.reduce((sum, point) => sum + point[1], 0) / pts.length;
  const dist = pts.reduce((sum, point) => sum + Math.hypot(point[0] - cx, point[1] - cy), 0) / pts.length;
  const scale = dist < 1e-8 ? 1 : Math.SQRT2 / dist;
  const T: Mat3 = [scale, 0, -scale * cx, 0, scale, -scale * cy, 0, 0, 1];
  const mapped = pts.map((point) => [scale * (point[0] - cx), scale * (point[1] - cy)] as [number, number]);
  return { T, mapped };
}

function invertSimilarity(T: Mat3): Mat3 {
  const scale = T[0] || 1;
  return [1 / scale, 0, -T[2] / scale, 0, 1 / scale, -T[5] / scale, 0, 0, 1];
}

function solve8(rows: number[][], values: number[]) {
  const n = 8;
  const m = rows.map((row, index) => [...row, values[index]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivot][col])) pivot = row;
    if (Math.abs(m[pivot][col]) < 1e-10) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    const div = m[col][col];
    for (let c = col; c <= n; c++) m[col][c] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = m[row][col];
      for (let c = col; c <= n; c++) m[row][c] -= factor * m[col][c];
    }
  }
  return m.map((row) => row[n]);
}

// Solves the normalised direct linear transform; with more than four pairs it is the least-squares fit.
function directLinear(src: [number, number][], dst: [number, number][]): Mat3 | null {
  const count = Math.min(src.length, dst.length);
  if (count < 4) return null;
  const source = similarity(src.slice(0, count));
  const target = similarity(dst.slice(0, count));
  const rows: number[][] = [];
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const [x, y] = source.mapped[i];
    const [u, v] = target.mapped[i];
    rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    rows.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }
  const h = count === 4 ? solve8(rows, values) : solve8(...normalEquations(rows, values));
  if (!h) return null;
  const normalized: Mat3 = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
  return composeHomography(composeHomography(invertSimilarity(target.T), normalized), source.T);
}

function normalEquations(rows: number[][], values: number[]): [number[][], number[]] {
  const ata = Array.from({ length: 8 }, () => Array<number>(8).fill(0));
  const atb = Array<number>(8).fill(0);
  rows.forEach((row, index) => {
    for (let r = 0; r < 8; r++) {
      if (row[r] === 0) continue;
      atb[r] += row[r] * values[index];
      for (let c = 0; c < 8; c++) ata[r][c] += row[r] * row[c];
    }
  });
  return [ata, atb];
}

export function solveHomography(src: [number, number][], dst: [number, number][]): Mat3 | null {
  if (src.length < 4 || dst.length < 4) return null;
  return directLinear(src.slice(0, 4), dst.slice(0, 4));
}

/** Least-squares homography through every pair. */
export function refitHomography(src: [number, number][], dst: [number, number][]) {
  return directLinear(src, dst);
}

// Shift, rotation and scale; exact for two pairs, least squares for more.
function solveSimilarity(src: [number, number][], dst: [number, number][]): Mat3 | null {
  const count = Math.min(src.length, dst.length);
  if (count < 2) return null;
  let sx = 0, sy = 0, dx = 0, dy = 0;
  for (let i = 0; i < count; i++) {
    sx += src[i][0];
    sy += src[i][1];
    dx += dst[i][0];
    dy += dst[i][1];
  }
  sx /= count;
  sy /= count;
  dx /= count;
  dy /= count;
  let dot = 0, cross = 0, norm = 0;
  for (let i = 0; i < count; i++) {
    const ax = src[i][0] - sx;
    const ay = src[i][1] - sy;
    const bx = dst[i][0] - dx;
    const by = dst[i][1] - dy;
    dot += ax * bx + ay * by;
    cross += ax * by - ay * bx;
    norm += ax * ax + ay * ay;
  }
  if (norm < 1e-9) return null;
  const a = dot / norm;
  const b = cross / norm;
  return [a, -b, dx - a * sx + b * sy, b, a, dy - b * sx - a * sy, 0, 0, 1];
}

function sample4(count: number, seed: number) {
  const random = (() => {
    let state = seed || 1;
    return () => {
      state = (Math.imul(1664525, state) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  })();
  const index = new Set<number>();
  while (index.size < 4) index.add(Math.floor(random() * count));
  return [...index];
}

export function estimateHomography(src: [number, number][], dst: [number, number][], threshold = 3) {
  const count = Math.min(src.length, dst.length);
  if (count < 4) return null;
  let best: { h: Mat3; inliers: number; indices: number[]; error: number } | null = null;
  const trials = count === 4 ? 1 : 40;
  for (let trial = 0; trial < trials; trial++) {
    const picked = count === 4 ? [0, 1, 2, 3] : sample4(count, trial + 1);
    const h = solveHomography(
      picked.map((index) => src[index]),
      picked.map((index) => dst[index]),
    );
    if (!h) continue;
    const indices: number[] = [];
    let error = 0;
    for (let i = 0; i < count; i++) {
      const point = applyHomography(h, src[i][0], src[i][1]);
      const distance = Math.hypot(point.x - dst[i][0], point.y - dst[i][1]);
      if (distance <= threshold) {
        indices.push(i);
        error += distance;
      }
    }
    if (!best || indices.length > best.inliers || (indices.length === best.inliers && error < best.error)) {
      best = { h, inliers: indices.length, indices, error };
    }
  }
  return best;
}

function score(h: Mat3, src: [number, number][], dst: [number, number][], threshold: number): Fit {
  const mask = new Uint8Array(src.length);
  const limit = threshold * threshold;
  let inliers = 0;
  let squares = 0;
  for (let i = 0; i < src.length; i++) {
    const [x, y] = src[i];
    const w = h[6] * x + h[7] * y + h[8];
    if (!(w > 1e-8)) continue;
    const ex = (h[0] * x + h[1] * y + h[2]) / w - dst[i][0];
    const ey = (h[3] * x + h[4] * y + h[5]) / w - dst[i][1];
    const d2 = ex * ex + ey * ey;
    if (d2 <= limit) {
      mask[i] = 1;
      inliers++;
      squares += d2;
    }
  }
  return { h, mask, inliers, rms: inliers ? Math.sqrt(squares / inliers) : Infinity };
}

type Solver = (src: [number, number][], dst: [number, number][]) => Mat3 | null;

function ransac(src: [number, number][], dst: [number, number][], size: number, solve: Solver, threshold: number) {
  let seed = src.length * 7919 + 17;
  const random = () => (seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296;
  let best: Fit | null = null;
  let needed = RANSAC_TRIALS;
  for (let trial = 0; trial < needed; trial++) {
    const picked: number[] = [];
    while (picked.length < size) {
      const index = Math.floor(random() * src.length);
      if (!picked.includes(index)) picked.push(index);
    }
    const h = solve(picked.map((index) => src[index]), picked.map((index) => dst[index]));
    if (!h || !h.every(Number.isFinite)) continue;
    const fit = score(h, src, dst, threshold);
    if (!best || fit.inliers > best.inliers || (fit.inliers === best.inliers && fit.rms < best.rms)) {
      best = fit;
      const all = (fit.inliers / src.length) ** size;
      const wanted = all >= 1 ? 0 : Math.ceil(Math.log(0.01) / Math.log(1 - all));
      needed = Math.min(RANSAC_TRIALS, Math.max(RANSAC_MIN_TRIALS, wanted));
    }
  }
  return best;
}

function refine(fit: Fit, src: [number, number][], dst: [number, number][], solve: Solver, threshold: number) {
  let best = fit;
  for (let round = 0; round < REFITS; round++) {
    const picked = [...best.mask.keys()].filter((index) => best.mask[index]);
    const h = solve(picked.map((index) => src[index]), picked.map((index) => dst[index]));
    if (!h || !h.every(Number.isFinite)) break;
    const next = score(h, src, dst, threshold);
    if (next.inliers < best.inliers) break;
    const same = next.inliers === best.inliers && next.mask.every((value, index) => value === best.mask[index]);
    best = next;
    if (same) break;
  }
  return best;
}

/** RANSAC then least-squares refits; with few inliers a similarity is safer than a full homography. */
export function fitHomography(src: [number, number][], dst: [number, number][], threshold = INLIER_PX): Fit | null {
  if (src.length < 4 || src.length !== dst.length) return null;
  const full = ransac(src, dst, 4, solveHomography, threshold);
  const fit = full && refine(full, src, dst, refitHomography, threshold);
  if (fit && fit.inliers >= SIMILARITY_BELOW) return fit;
  const simple = ransac(src, dst, 2, solveSimilarity, threshold);
  return simple && refine(simple, src, dst, solveSimilarity, threshold);
}

export function grayFromRGBA(data: Uint8ClampedArray, width: number, height: number) {
  const gray = new Float32Array(width * height);
  for (let pixel = 0, index = 0; pixel < gray.length; pixel += 1, index += 4) {
    gray[pixel] = (data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114) / 255;
  }
  return gray;
}

export function frameFromImageData(image: ImageData, maxWidth = 480): GrayFrame {
  const scale = Math.min(1, maxWidth / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  if (width === image.width && height === image.height) {
    return { gray: grayFromRGBA(image.data, width, height), width, height };
  }
  const gray = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.floor(x / scale));
      const sy = Math.min(image.height - 1, Math.floor(y / scale));
      const index = (sy * image.width + sx) * 4;
      gray[y * width + x] = (image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114) / 255;
    }
  }
  return { gray, width, height };
}

let rowScratch = new Float32Array(0);

const clampTo = (value: number, max: number) => (value < 0 ? 0 : value > max ? max : value);

// [1 4 6 4 1]/16 in both directions, keeping every second pixel.
function downsample({ img, w, h }: Level): Level {
  const width = w >> 1;
  const height = h >> 1;
  if (rowScratch.length < width * h) rowScratch = new Float32Array(width * h);
  const rows = rowScratch;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < width; x++) {
      const c = 2 * x;
      const at = row + c;
      rows[y * width + x] = c >= 2 && c + 2 < w
        ? (img[at - 2] + 4 * (img[at - 1] + img[at + 1]) + 6 * img[at] + img[at + 2]) / 16
        : (img[row + clampTo(c - 2, w - 1)] + 4 * (img[row + clampTo(c - 1, w - 1)] + img[row + clampTo(c + 1, w - 1)]) +
            6 * img[at] + img[row + clampTo(c + 2, w - 1)]) / 16;
    }
  }
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const c = 2 * y;
    const r0 = clampTo(c - 2, h - 1) * width;
    const r1 = clampTo(c - 1, h - 1) * width;
    const r2 = c * width;
    const r3 = clampTo(c + 1, h - 1) * width;
    const r4 = clampTo(c + 2, h - 1) * width;
    for (let x = 0; x < width; x++) {
      out[y * width + x] = (rows[r0 + x] + 4 * (rows[r1 + x] + rows[r3 + x]) + 6 * rows[r2 + x] + rows[r4 + x]) / 16;
    }
  }
  return { img: out, w: width, h: height };
}

function pyramidDepth(width: number, height: number) {
  let levels = LEVELS;
  while (levels > 1 && Math.min(width, height) / 2 ** (levels - 1) < MIN_TOP_SIDE) levels--;
  return levels;
}

/** Level 0 is the frame itself; each further level is blurred and half the size. */
export function buildPyramid(frame: GrayFrame, levels = pyramidDepth(frame.width, frame.height)): Pyramid {
  const pyramid: Pyramid = [{ img: frame.gray, w: frame.width, h: frame.height }];
  while (pyramid.length < levels) pyramid.push(downsample(pyramid[pyramid.length - 1]));
  return pyramid;
}

function bilinear(img: Float32Array, w: number, h: number, x: number, y: number) {
  const cx = clampTo(x, w - 1);
  const cy = clampTo(y, h - 1);
  const x0 = Math.min(w - 2, Math.floor(cx));
  const y0 = Math.min(h - 2, Math.floor(cy));
  const fx = cx - x0;
  const fy = cy - y0;
  const at = y0 * w + x0;
  return (img[at] * (1 - fx) + img[at + 1] * fx) * (1 - fy) + (img[at + w] * (1 - fx) + img[at + w + 1] * fx) * fy;
}

// Samples a side x side grid centred on (x, y). Every sample shares the same sub-pixel weights.
function sampleGrid({ img, w, h }: Level, x: number, y: number, side: number, out: Float32Array) {
  const half = (side - 1) / 2;
  const left = Math.floor(x - half);
  const top = Math.floor(y - half);
  const fx = x - half - left;
  const fy = y - half - top;
  if (left >= 0 && top >= 0 && left + side < w && top + side < h) {
    const w00 = (1 - fx) * (1 - fy);
    const w10 = fx * (1 - fy);
    const w01 = (1 - fx) * fy;
    const w11 = fx * fy;
    for (let j = 0, o = 0; j < side; j++) {
      for (let i = 0, p = (top + j) * w + left; i < side; i++, o++, p++) {
        out[o] = w00 * img[p] + w10 * img[p + 1] + w01 * img[p + w] + w11 * img[p + w + 1];
      }
    }
    return;
  }
  for (let j = 0, o = 0; j < side; j++) {
    for (let i = 0; i < side; i++, o++) out[o] = bilinear(img, w, h, left + i + fx, top + j + fy);
  }
}

// Samples a side x side grid through the affine map (u, v) -> (x + a u + b v, y + c u + d v).
function sampleWarped({ img, w, h }: Level, x: number, y: number, a: number, b: number, c: number, d: number, out: Float32Array) {
  const half = (PATCH - 1) / 2;
  for (let j = 0, o = 0; j < PATCH; j++) {
    for (let i = 0; i < PATCH; i++, o++) {
      const u = i - half;
      const v = j - half;
      out[o] = bilinear(img, w, h, x + a * u + b * v, y + c * u + d * v);
    }
  }
}

const template = new Float32Array(PATCH * PATCH);
const tValue = new Float32Array(AREA);
const tGx = new Float32Array(AREA);
const tGy = new Float32Array(AREA);
const sampled = new Float32Array(AREA);
const found = { x: 0, y: 0, corr: 0 };

/**
 * Brightness-normalised Lucas-Kanade on one level: aligns the window of `level` near (x, y) to
 * `template`, comparing (I - mean I) * clamp(sd T / sd I, 1/3, 3) with (T - mean T).
 */
function alignLevel(level: Level, x: number, y: number) {
  let gxx = 0, gxy = 0, gyy = 0, sumT = 0, sumTT = 0, sumGx = 0, sumGy = 0, sumGxT = 0, sumGyT = 0;
  for (let j = 0, k = 0; j < SIDE; j++) {
    for (let i = 0; i < SIDE; i++, k++) {
      const p = (j + 1) * PATCH + i + 1;
      const value = template[p];
      const gx = (template[p + 1] - template[p - 1]) / 2;
      const gy = (template[p + PATCH] - template[p - PATCH]) / 2;
      tValue[k] = value;
      tGx[k] = gx;
      tGy[k] = gy;
      gxx += gx * gx;
      gxy += gx * gy;
      gyy += gy * gy;
      sumT += value;
      sumTT += value * value;
      sumGx += gx;
      sumGy += gy;
      sumGxT += gx * value;
      sumGyT += gy * value;
    }
  }
  const trace = gxx + gyy;
  const det = gxx * gyy - gxy * gxy;
  if ((trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2 / AREA < MIN_EIGEN) return false;
  const meanT = sumT / AREA;
  const sdT = Math.sqrt(Math.max(0, sumTT / AREA - meanT * meanT));
  const bxT = sumGxT - meanT * sumGx;
  const byT = sumGyT - meanT * sumGy;
  let corr = 0;
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    if (x < -RADIUS || y < -RADIUS || x > level.w + RADIUS || y > level.h + RADIUS) return false;
    sampleGrid(level, x, y, SIDE, sampled);
    let sumI = 0, sumII = 0, sumTI = 0, sumGxI = 0, sumGyI = 0;
    for (let k = 0; k < AREA; k++) {
      const value = sampled[k];
      sumI += value;
      sumII += value * value;
      sumTI += tValue[k] * value;
      sumGxI += tGx[k] * value;
      sumGyI += tGy[k] * value;
    }
    const meanI = sumI / AREA;
    const sdI = Math.sqrt(Math.max(0, sumII / AREA - meanI * meanI));
    if (sdI < 1e-5 || sdT < 1e-5) {
      corr = 0;
      break;
    }
    corr = (sumTI / AREA - meanT * meanI) / (sdT * sdI);
    const gain = Math.min(3, Math.max(1 / 3, sdT / sdI));
    const bx = bxT - gain * (sumGxI - meanI * sumGx);
    const by = byT - gain * (sumGyI - meanI * sumGy);
    const dx = (gyy * bx - gxy * by) / det;
    const dy = (gxx * by - gxy * bx) / det;
    x += dx;
    y += dy;
    if (dx * dx + dy * dy < CONVERGED_PX * CONVERGED_PX) break;
  }
  found.x = x;
  found.y = y;
  found.corr = corr;
  return true;
}

const inside = (level: Level, x: number, y: number) =>
  x >= RADIUS + 1 && y >= RADIUS + 1 && x <= level.w - RADIUS - 2 && y <= level.h - RADIUS - 2;

// Coarse to fine; a level whose template is too flat keeps the guess from the level above.
function trackPoint(from: Pyramid, to: Pyramid, px: number, py: number, qx: number, qy: number) {
  const top = Math.min(from.length, to.length) - 1;
  let x = qx / 2 ** top;
  let y = qy / 2 ** top;
  for (let level = top; level >= 0; level--) {
    const scale = 2 ** level;
    sampleGrid(from[level], px / scale, py / scale, PATCH, template);
    const aligned = alignLevel(to[level], x, y);
    if (aligned) {
      x = found.x;
      y = found.y;
    } else if (level === 0) return false;
    if (level > 0) {
      x *= 2;
      y *= 2;
    }
  }
  found.x = x;
  found.y = y;
  return inside(to[0], x, y);
}

/** Tracks interleaved (x, y) points from one pyramid to the next, starting each at its guess. */
export function trackPoints(from: Pyramid, to: Pyramid, points: Float64Array, guesses: Float64Array) {
  const count = points.length / 2;
  const out = { points: new Float64Array(points.length), corr: new Float32Array(count), ok: new Uint8Array(count) };
  for (let i = 0; i < count; i++) {
    const ok = trackPoint(from, to, points[2 * i], points[2 * i + 1], guesses[2 * i], guesses[2 * i + 1]);
    out.points[2 * i] = found.x;
    out.points[2 * i + 1] = found.y;
    out.corr[i] = ok ? found.corr : 0;
    out.ok[i] = ok ? 1 : 0;
  }
  return out;
}

function cornerScore(gray: Float32Array, w: number, x: number, y: number) {
  let ix2 = 0;
  let iy2 = 0;
  let ixy = 0;
  for (let yy = -1; yy <= 1; yy++) {
    for (let xx = -1; xx <= 1; xx++) {
      const index = (y + yy) * w + (x + xx);
      const ix = gray[index + 1] - gray[index - 1];
      const iy = gray[index + w] - gray[index - w];
      ix2 += ix * ix;
      iy2 += iy * iy;
      ixy += ix * iy;
    }
  }
  const trace = ix2 + iy2;
  const det = ix2 * iy2 - ixy * ixy;
  return (trace - Math.sqrt(Math.max(0, trace * trace - 4 * det))) / 2;
}

// The best corner of each cell, strongest first; cells marked in `skip` are left out.
function cellCorners(gray: Float32Array, w: number, h: number, cell: number, stride: number, skip?: Uint8Array) {
  const columns = Math.ceil(w / cell);
  const corners: { x: number; y: number; score: number }[] = [];
  for (let cy = 0, row = 0; cy < h; cy += cell, row++) {
    for (let cx = 0, column = 0; cx < w; cx += cell, column++) {
      if (skip?.[row * columns + column]) continue;
      let top = CORNER_SCORE;
      let px = -1;
      let py = -1;
      for (let y = Math.max(cy, MARGIN); y < Math.min(h - MARGIN, cy + cell); y += stride) {
        for (let x = Math.max(cx, MARGIN); x < Math.min(w - MARGIN, cx + cell); x += stride) {
          const score = cornerScore(gray, w, x, y);
          if (score > top) {
            top = score;
            px = x;
            py = y;
          }
        }
      }
      if (px >= 0) corners.push({ x: px, y: py, score: top });
    }
  }
  return corners.sort((a, b) => b.score - a.score);
}

export function strongCorners(gray: Float32Array, w: number, h: number, limit = KEY_CORNERS) {
  return cellCorners(gray, w, h, CELL, 1).slice(0, limit).map(({ x, y }) => ({ x, y }));
}

// Normalised correlation of the patches centred on pixels a and b.
function correlate(img: Float32Array, w: number, a: number, b: number) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0;
  for (let j = -ALIKE_RADIUS; j <= ALIKE_RADIUS; j++) {
    for (let i = j * w - ALIKE_RADIUS, end = i + 2 * ALIKE_RADIUS; i <= end; i++) {
      const p = img[a + i];
      const q = img[b + i];
      sa += p;
      sb += q;
      saa += p * p;
      sbb += q * q;
      sab += p * q;
    }
  }
  const n = (2 * ALIKE_RADIUS + 1) ** 2;
  return (sab - (sa * sb) / n) / Math.sqrt(Math.max(1e-12, (saa - (sa * sa) / n) * (sbb - (sb * sb) / n)));
}

// How far along its row or column the point at full-size (x, y) of `pyramid` repeats (see TrackPoint).
// On a shelf of identical spines every point repeats one spine away.
function lookalike(pyramid: Pyramid, x: number, y: number) {
  const level = Math.min(1, pyramid.length - 1);
  const scale = 2 ** level;
  const { img, w, h } = pyramid[level];
  const cx = Math.round(x / scale);
  const cy = Math.round(y / scale);
  const r = ALIKE_RADIUS;
  if (cx < r || cy < r || cx >= w - r || cy >= h - r) return 0;
  const at = cy * w + cx;
  let nearest = Infinity;
  let edge = false;
  for (const [step, from, size] of [[1, cx, w], [-1, cx, w], [w, cy, h], [-w, cy, h]]) {
    const sign = Math.sign(step);
    let dipped = false;
    for (let d = ALIKE_FROM; d <= ALIKE_TO && from + sign * d >= r && from + sign * d < size - r; d++) {
      const c = correlate(img, w, at, at + step * d);
      if (c < ALIKE_VALLEY) dipped = true;
      else if (c >= ALIKE_CORR) {
        if (dipped) nearest = Math.min(nearest, d * scale);
        else edge = true;
        break;
      }
    }
  }
  return nearest < Infinity || !edge ? nearest : 0;
}

function project(h: Mat3, xy: Float64Array) {
  const out = new Float64Array(xy.length);
  for (let i = 0; i < xy.length; i += 2) {
    const point = applyHomography(h, xy[i], xy[i + 1]);
    out[i] = point.x;
    out[i + 1] = point.y;
  }
  return out;
}

// Local scale and rotation of `h` around (x, y).
function shape(h: Mat3, x: number, y: number) {
  const w = h[6] * x + h[7] * y + h[8];
  const u = (h[0] * x + h[1] * y + h[2]) / w;
  const v = (h[3] * x + h[4] * y + h[5]) / w;
  const a = (h[0] - u * h[6]) / w;
  const b = (h[1] - u * h[7]) / w;
  const c = (h[3] - v * h[6]) / w;
  const d = (h[4] - v * h[7]) / w;
  const det = a * d - b * c;
  const even = Math.hypot(a + d, c - b) / 2;
  const odd = Math.hypot(a - d, c + b) / 2;
  return { w, det, a, b, c, d, scale: Math.sqrt(Math.abs(det)), rotation: Math.atan2(c - b, a + d), stretch: (even + odd) / Math.abs(even - odd) };
}

// Hand motion between two frames looks locally like a shift, turn and zoom; a step that stretches
// one direction more than the other is a false match, however well its points agree.
function plausible(h: Mat3, width: number, height: number) {
  const local = shape(h, width / 2, height / 2);
  return local.w > 0 && local.det > 0 && local.scale >= MIN_SCALE && local.scale <= MAX_SCALE &&
    Math.abs(local.rotation) <= MAX_ROTATION && local.stretch <= MAX_STRETCH;
}

function median(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function judge(fit: Fit | null, dst: [number, number][], corr: number[], rules: Rules, width: number, height: number, tried = dst.length) {
  if (!fit || fit.inliers < rules.inliers) return "inliers";
  if (fit.inliers < tried * rules.ratio) return "ratio";
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const kept: number[] = [];
  dst.forEach(([x, y], index) => {
    if (!fit.mask[index]) return;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    kept.push(corr[index]);
  });
  if (maxX - minX < width * rules.spread || maxY - minY < height * rules.spread) return "spread";
  if (fit.rms > rules.rms) return "rms";
  if (median(kept) < rules.corr) return "correlation";
  return null;
}

/** `tracked` marks the candidates that passed the forward-backward check, `mask` those that fit. */
type Attempt = { fit: Fit | null; candidates: number[]; tracked: Uint8Array; mask: Uint8Array; correlated: number; reason: string | null };

// Tracks the in-view points from the reference frame into `frame` and fits the motion between them.
function flow(state: TrackState, frame: Pyramid, candidates: number[], refXY: Float64Array, prior: Mat3): Attempt {
  const forward = trackPoints(state.ref, frame, refXY, project(prior, refXY));
  const back: number[] = [];
  for (let i = 0; i < candidates.length; i++) if (forward.ok[i] && forward.corr[i] >= FB_MIN_CORR) back.push(i);
  const from = new Float64Array(back.length * 2);
  back.forEach((i, j) => {
    from[2 * j] = forward.points[2 * i];
    from[2 * j + 1] = forward.points[2 * i + 1];
  });
  const backward = trackPoints(frame, state.ref, from, project(invertHomography(prior), from));
  const src: [number, number][] = [];
  const dst: [number, number][] = [];
  const corr: number[] = [];
  const survivors: number[] = [];
  back.forEach((i, j) => {
    const ex = backward.points[2 * j] - refXY[2 * i];
    const ey = backward.points[2 * j + 1] - refXY[2 * i + 1];
    if (!backward.ok[j] || ex * ex + ey * ey > FB_MAX_PX * FB_MAX_PX) return;
    src.push([refXY[2 * i], refXY[2 * i + 1]]);
    dst.push([forward.points[2 * i], forward.points[2 * i + 1]]);
    corr.push(forward.corr[i]);
    survivors.push(i);
  });
  const fit = fitHomography(src, dst);
  const tracked = new Uint8Array(candidates.length);
  const mask = new Uint8Array(candidates.length);
  survivors.forEach((i, j) => {
    tracked[i] = 1;
    mask[i] = fit?.mask[j] ?? 0;
  });
  let reason = judge(fit, dst, corr, STEP, state.width, state.height);
  if (fit && reason !== "inliers" && !plausible(fit.h, state.width, state.height)) reason = "shape";
  return { fit, candidates, tracked, mask, correlated: back.length, reason };
}

function inView(h: Mat3, point: TrackPoint, width: number, height: number, margin: number) {
  const p = applyHomography(h, point.kx, point.ky);
  return p.x >= margin && p.y >= margin && p.x <= width - 1 - margin && p.y <= height - 1 - margin ? p : null;
}

/** `distinct` and `alike` are the corners tried that repeat nowhere near and that repeat, and how many of each fit. */
export type Anchoring = { h: Mat3 | null; inliers: number; tried: number; distinct: [number, number]; alike: [number, number] };

/**
 * Re-finds the keyframe's own corners in `frame`, starting from `guess` (keyframe to frame), with
 * templates warped by the guess. `h` is the keyframe-to-frame homography, set only when it is well
 * supported, by at least half the corners tried, and agrees with the guess.
 */
export function alignToKeyframe(state: TrackState, frame: Pyramid, guess: Mat3): Anchoring {
  const { width, height, keyframe } = state;
  const visible: { kx: number; ky: number; x: number; y: number; alike: number }[] = [];
  for (let i = 0; i < state.corners; i++) {
    const point = state.points[i];
    const p = inView(guess, point, width, height, MARGIN);
    if (p) visible.push({ kx: point.kx, ky: point.ky, x: p.x, y: p.y, alike: point.alike });
  }
  const tried = Math.min(visible.length, ANCHOR_POINTS);
  const back = invertHomography(guess);
  const src: [number, number][] = [];
  const dst: [number, number][] = [];
  const corr: number[] = [];
  const alikes: number[] = [];
  const distinct: [number, number] = [0, 0];
  const alike: [number, number] = [0, 0];
  for (let n = 0; n < tried; n++) {
    const point = visible[Math.floor((n * visible.length) / tried)];
    if (point.alike === Infinity) distinct[0]++;
    else if (point.alike) alike[0]++;
    const local = shape(back, point.x, point.y);
    let x = point.x;
    let y = point.y;
    let ok = true;
    for (let level = Math.min(1, frame.length - 1); level >= 0 && ok; level--) {
      const scale = 2 ** level;
      const source = clampTo(Math.round(Math.log2(Math.max(1e-6, local.scale * scale))), keyframe.length - 1);
      const ratio = scale / 2 ** source;
      sampleWarped(keyframe[source], point.kx / 2 ** source, point.ky / 2 ** source,
        local.a * ratio, local.b * ratio, local.c * ratio, local.d * ratio, template);
      if (alignLevel(frame[level], x / scale, y / scale)) {
        x = found.x * scale;
        y = found.y * scale;
      } else if (level === 0) ok = false;
    }
    if (!ok || !inside(frame[0], x, y) || Math.hypot(x - point.x, y - point.y) > ANCHOR_MOVE_PX || found.corr < ANCHOR_POINT_CORR) continue;
    src.push([point.x, point.y]);
    dst.push([x, y]);
    corr.push(found.corr);
    alikes.push(point.alike);
  }
  // The fit is a correction to the guess, so a few clustered corners only nudge it. Corners that
  // were tried but not found count against it: a wrong guess still finds a few look-alikes.
  const fit = fitHomography(src, dst);
  alikes.forEach((value, i) => {
    if (!fit?.mask[i]) return;
    if (value === Infinity) distinct[1]++;
    else if (value) alike[1]++;
  });
  const refused: Anchoring = { h: null, inliers: fit?.inliers ?? 0, tried, distinct, alike };
  if (!fit || judge(fit, dst, corr, ANCHOR, width, height, tried)) return refused;
  for (const gx of [0.15, 0.5, 0.85]) {
    for (const gy of [0.15, 0.5, 0.85]) {
      const p = applyHomography(fit.h, gx * width, gy * height);
      if (Math.hypot(p.x - gx * width, p.y - gy * height) > ANCHOR_AGREE_PX) return refused;
    }
  }
  return { ...refused, h: normalize(composeHomography(fit.h, guess)) };
}

/** The in-view points that repeat nowhere near, and how far away the others repeat. */
type Repeats = { distinct: number; periods: number[] };

// Too few points that repeat nowhere near to tell a pose from one a repeat away.
const unvouched = ({ distinct, periods }: Repeats) => periods.length >= DISTINCT_MIN && distinct < Math.max(DISTINCT_MIN, periods.length / 4);

// The step or pose rests on the look-alikes. `distinct` and `alike` are [tried, fit].
const outvoted = (distinct: [number, number], alike: [number, number]) =>
  alike[0] >= DISTINCT_MIN && distinct[1] / Math.max(1, distinct[0]) < (DISTINCT_SHARE * alike[1]) / alike[0];

// On a shelf of look-alike spines a motion one spine off fits the look-alike points as well as the
// true one. Points without a look-alike tell the two apart: they must fit about as often as the
// look-alikes, both among the points tracked from the reference frame and among the keyframe
// corners re-found. With too few of them in view nothing can, and only a clean, slow step straight
// after an accepted slow one stands; a fast move that lands on a look-alike blurs and loses points.
function lookalikeRisk(state: TrackState, attempt: Attempt, anchored: Anchoring, repeats: Repeats, motion: Mat3, t: number) {
  if (repeats.periods.length < DISTINCT_MIN) return false;
  if (!unvouched(repeats)) {
    const distinct: [number, number] = [0, 0];
    const alike: [number, number] = [0, 0];
    attempt.candidates.forEach((index, i) => {
      const value = state.points[index].alike;
      const tally = value === Infinity ? distinct : value ? alike : null;
      if (!tally || !attempt.tracked[i]) return;
      tally[0]++;
      tally[1] += attempt.mask[i];
    });
    return outvoted(distinct, alike) || outvoted(anchored.distinct, anchored.alike);
  }
  const limit = median(repeats.periods) * ALIKE_STEP;
  const moved = (h: Mat3) => centreShift(h, state.width, state.height) > limit;
  return t - state.refT > ALIKE_GAP_MS || moved(motion) || (state.velocity !== null && moved(state.velocity.h)) ||
    (attempt.fit?.inliers ?? 0) < attempt.candidates.length * ALIKE_FIT;
}

export function beginTrack(frame: GrayFrame, t = 0) {
  const corners = strongCorners(frame.gray, frame.width, frame.height);
  const ok = corners.length >= MIN_POINTS;
  const pyramid = buildPyramid(frame);
  const state: TrackState | null = ok
    ? {
        width: frame.width,
        height: frame.height,
        keyframe: pyramid,
        corners: corners.length,
        points: corners.map(({ x, y }) => ({ kx: x, ky: y, miss: 0, added: false, alike: lookalike(pyramid, x, y) })),
        ref: pyramid,
        refT: t,
        keyToRef: IDENTITY,
        velocity: null,
      }
    : null;
  return { state, ok, points: corners.length };
}

function prediction(state: TrackState, t: number) {
  const elapsed = t - state.refT;
  if (!state.velocity || elapsed <= 0 || elapsed > PREDICT_MS) return null;
  return extrapolateHomography(state.velocity, Math.min(elapsed, state.velocity.dt * MAX_PREDICT_FACTOR));
}

function centreShift(h: Mat3, width: number, height: number) {
  const p = applyHomography(h, width / 2, height / 2);
  return Math.hypot(p.x - width / 2, p.y - height / 2);
}

// New points from the cells that have no inlier, mapped back into keyframe coordinates.
function replenish(points: TrackPoint[], pyramid: Pyramid, keyToCur: Mat3, occupied: [number, number][]) {
  const frame = pyramid[0];
  const columns = Math.ceil(frame.w / CELL);
  const skip = new Uint8Array(columns * Math.ceil(frame.h / CELL));
  for (const [x, y] of occupied) skip[Math.floor(y / CELL) * columns + Math.floor(x / CELL)] = 1;
  const fresh = cellCorners(frame.img, frame.w, frame.h, CELL, 2, skip).slice(0, REFILL_MAX);
  if (!fresh.length) return points;
  let kept = points;
  const excess = kept.length + fresh.length - MAX_POINTS;
  if (excess > 0) {
    // Make room by forgetting added points that are out of view, oldest first.
    let dropped = 0;
    kept = kept.filter((point) => {
      if (dropped >= excess || !point.added || inView(keyToCur, point, frame.w, frame.h, 0)) return true;
      dropped++;
      return false;
    });
  }
  const back = invertHomography(keyToCur);
  const room = Math.max(0, MAX_POINTS - kept.length);
  return [
    ...kept,
    ...fresh.slice(0, room).map(({ x, y }) => {
      const k = applyHomography(back, x, y);
      return { kx: k.x, ky: k.y, miss: 0, added: true, alike: lookalike(pyramid, x, y) };
    }),
  ];
}

export function stepTrack(state: TrackState, frame: GrayFrame, options: { t?: number } = {}): StepResult {
  const t = options.t ?? state.refT + 100;
  const failed = (reason: string, hard: boolean, inliers = 0, rms = 0): StepResult =>
    ({ state, steady: false, status: "unsteady", homography: null, velocity: null, inliers, rms, reason, hard });
  if (frame.width !== state.width || frame.height !== state.height) return failed("size", true);
  const candidates: number[] = [];
  const refXY: number[] = [];
  const repeats: Repeats = { distinct: 0, periods: [] };
  state.points.forEach((point, index) => {
    const p = inView(state.keyToRef, point, state.width, state.height, MARGIN);
    if (!p) return;
    candidates.push(index);
    refXY.push(p.x, p.y);
    if (point.alike === Infinity) repeats.distinct++;
    else if (point.alike) repeats.periods.push(point.alike);
  });
  if (!candidates.length) return failed("no-points", true);
  const pyramid = buildPyramid(frame, state.ref.length);
  const xy = Float64Array.from(refXY);
  // Among look-alikes the predicted motion only finds the copy it points at, so the search starts
  // from no motion there.
  const predicted = unvouched(repeats) ? null : prediction(state, t);
  let attempt = flow(state, pyramid, candidates, xy, predicted ?? IDENTITY);
  let correlated = attempt.correlated;
  if (attempt.reason && predicted && centreShift(predicted, state.width, state.height) > RETRY_SHIFT_PX) {
    const still = flow(state, pyramid, candidates, xy, IDENTITY);
    correlated = Math.max(correlated, still.correlated);
    if (!still.reason || (still.fit?.inliers ?? 0) > (attempt.fit?.inliers ?? 0)) attempt = still;
  }
  const { fit, reason } = attempt;
  const fail = (why = reason ?? "inliers") => failed(why, correlated < MIN_POINTS, fit?.inliers ?? 0, fit?.rms ?? 0);
  if (!fit || (reason && !RESCUABLE.has(reason))) return fail();
  const chained = composeHomography(fit.h, state.keyToRef);
  const anchored = alignToKeyframe(state, pyramid, chained);
  // Matching a sharp frame against a blurred reference is too loose to pass alone, so a step that
  // only missed on precision is taken when the keyframe confirms it. Motion blur and look-alike
  // spines can carry a small cluster of points to the same wrong place, so a step resting on few
  // points needs the same confirmation while the keyframe is in view.
  const weak = fit.inliers < CONFIRM_BELOW && anchored.tried >= CONFIRM_FROM;
  if (!anchored.h && (reason || weak)) return fail(reason ?? "keyframe");
  const keyToCur = normalize(anchored.h ?? chained);
  const motion = normalize(composeHomography(keyToCur, invertHomography(state.keyToRef)));
  if (lookalikeRisk(state, attempt, anchored, repeats, motion, t)) return fail("look-alike");
  const dt = t - state.refT;
  const occupied: [number, number][] = [];
  let points = state.points.map((point) => ({ ...point }));
  attempt.candidates.forEach((index, i) => {
    if (attempt.mask[i]) {
      points[index].miss = 0;
      const p = applyHomography(keyToCur, points[index].kx, points[index].ky);
      occupied.push([p.x, p.y]);
    } else points[index].miss += 1;
  });
  points = points.filter((point) => !point.added || point.miss < MAX_MISSES);
  if (fit.inliers < REFILL_BELOW) points = replenish(points, pyramid, keyToCur, occupied);
  const velocity = dt > 0 ? { h: motion, dt } : null;
  return {
    state: { ...state, points, ref: pyramid, refT: t, keyToRef: keyToCur, velocity },
    steady: true,
    status: "tracked",
    homography: keyToCur,
    velocity,
    inliers: fit.inliers,
    rms: fit.rms,
    reason: null,
    hard: false,
  };
}

export function projectAnchor(h: Mat3, x: number, y: number, width: number, height: number) {
  const point = applyHomography(h, x * width, y * height);
  return { x: point.x / width, y: point.y / height };
}
