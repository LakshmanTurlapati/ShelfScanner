import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FRAME_W = 480;
export const FRAME_H = 853;
export const FOCAL = 630;
const CX = (FRAME_W - 1) / 2;
const CY = (FRAME_H - 1) / 2;
const TEXTURE = 2048;
const COVERED_LEVEL = 0.015;
const GOLDEN = fileURLToPath(new URL("../golden/", import.meta.url));

export type Mat3 = number[];
export type Spine = { x0: number; x1: number; y0: number; y1: number };
// Grayscale photo at twice the frame scale; spines are in frame-scale pixels of the photo.
export type Source = { name: string; width: number; height: number; pixels: Float32Array; spines: Spine[] };
export type Pose = { yaw: number; pitch: number; roll: number; zoom: number; tx: number; ty: number; gain: number; offset: number; cover: number };
export type Optics = { exposureMs: number; shutterMs: number; noise: number };
export type Scene = { source: Source; texture: Float32Array; x0: number; y0: number; dir: 1 | -1 };
export type GrayFrame = { gray: Float32Array; width: number; height: number };

export const REST: Pose = { yaw: 0, pitch: 0, roll: 0, zoom: 1, tx: 0, ty: 0, gain: 1, offset: 0, cover: 0 };

export function multiply(a: Mat3, b: Mat3): Mat3 {
  const out = Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
  }
  return out;
}

export function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m;
  const co = [e * i - f * h, c * h - b * i, b * f - c * e, f * g - d * i, a * i - c * g, c * d - a * f, d * h - e * g, b * g - a * h, a * e - b * d];
  const det = a * co[0] + b * co[3] + c * co[6];
  return co.map((value) => value / det);
}

export function project(m: Mat3, x: number, y: number): [number, number] {
  const w = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

export function inView(x: number, y: number) {
  return x >= 0 && y >= 0 && x <= FRAME_W - 1 && y <= FRAME_H - 1;
}

function rotation(yaw: number, pitch: number): Mat3 {
  const a = (yaw * Math.PI) / 180;
  const b = (pitch * Math.PI) / 180;
  const k = [FOCAL, 0, CX, 0, FOCAL, CY, 0, 0, 1];
  const kInv = [1 / FOCAL, 0, -CX / FOCAL, 0, 1 / FOCAL, -CY / FOCAL, 0, 0, 1];
  const yawT = [Math.cos(a), 0, -Math.sin(a), 0, 1, 0, Math.sin(a), 0, Math.cos(a)];
  const pitchT = [1, 0, 0, 0, Math.cos(b), Math.sin(b), 0, -Math.sin(b), Math.cos(b)];
  return multiply(multiply(k, multiply(pitchT, yawT)), kInv);
}

// H = K·R·K⁻¹·S: maps the rest-pose frame (a crop of the photo) to the frame seen at this pose.
export function poseMatrix(p: Pose): Mat3 {
  const r = (p.roll * Math.PI) / 180;
  const c = Math.cos(r) * p.zoom;
  const s = Math.sin(r) * p.zoom;
  const similarity = [c, -s, CX + p.tx - c * CX + s * CY, s, c, CY + p.ty - s * CX - c * CY, 0, 0, 1];
  return multiply(rotation(p.yaw, p.pitch), similarity);
}

export function mulberry(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(...parts: (string | number)[]) {
  let h = 2166136261;
  for (const char of parts.join("|")) h = Math.imul(h ^ char.charCodeAt(0), 16777619);
  return h >>> 0;
}

function shared(length: number) {
  return new Float32Array(new SharedArrayBuffer(length * 4));
}

const DECODE = `
import sys
from PIL import Image, ImageOps
im = ImageOps.exif_transpose(Image.open(sys.argv[1])).convert("RGB")
s = float(sys.argv[2]) / im.height
g = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS).convert("L")
sys.stdout.buffer.write(b"%d %d\\n" % g.size + g.tobytes())
`;

type Golden = { image: string; truth: { title: string | null; box: { x: number; y: number; w: number; h: number } }[] };

// The frame covers 0.75 of the photo's height, as in the measurements the plan is based on.
export function decodeGolden(name: string): Source {
  const spec = JSON.parse(readFileSync(`${GOLDEN}${name}.json`, "utf8")) as Golden;
  const raw = execFileSync("python3", ["-B", "-c", DECODE, `${GOLDEN}${spec.image}`, String((2 * FRAME_H) / 0.75)], { maxBuffer: 1 << 27 });
  const header = raw.indexOf(10);
  const [width, height] = raw.subarray(0, header).toString().split(" ").map(Number);
  const pixels = shared(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = raw[header + 1 + i] / 255;
  // Unreadable spines are kept: they are where a fuller read would put labels, and they cover the thin top row.
  const spines = spec.truth.map(({ box }) => ({
    x0: (box.x * width) / 2,
    x1: ((box.x + box.w) * width) / 2,
    y0: (box.y * height) / 2,
    y1: ((box.y + box.h) * height) / 2,
  }));
  return { name, width, height, pixels, spines };
}

// One spine repeated side by side: every copy looks alike, so a relock onto a neighbour is a real risk.
export function tileSource(base: Source, from: number, to: number, copies: number, name = `${base.name}-tiled`): Source {
  const left = Math.round(from * base.width);
  const tile = Math.round(to * base.width) - left;
  const width = tile * copies;
  const pixels = shared(width * base.height);
  for (let y = 0; y < base.height; y++) {
    const row = base.pixels.subarray(y * base.width + left, y * base.width + left + tile);
    for (let copy = 0; copy < copies; copy++) pixels.set(row, y * width + copy * tile);
  }
  const middle = ((from + to) / 2) * (base.width / 2);
  const spine = base.spines.find((item) => item.x0 <= middle && item.x1 >= middle) ?? { y0: 0, y1: base.height / 2 };
  const spines = Array.from({ length: copies }, (_, copy) => ({ x0: (copy * tile) / 2, x1: ((copy + 1) * tile) / 2, y0: spine.y0, y1: spine.y1 }));
  return { name, width, height: base.height, pixels, spines };
}

// The photo with one spine repeated across its upper rows, so only part of the view looks alike.
export function tileRows(base: Source, from: number, to: number, rows: number, name: string): Source {
  const left = Math.round(from * base.width);
  const tile = Math.round(to * base.width) - left;
  const cut = Math.round(rows * base.height);
  const pixels = shared(base.pixels.length);
  pixels.set(base.pixels);
  for (let y = 0; y < cut; y++) {
    for (let x = 0; x < base.width; x++) pixels[y * base.width + x] = base.pixels[y * base.width + left + ((((x - left) % tile) + tile) % tile)];
  }
  // Below the cut the photo's own spines stand; the ones crossing it keep only their lower part.
  const first = left % tile;
  const copies = Array.from({ length: Math.floor((base.width - first) / tile) }, (_, i) => ({ x0: (first + i * tile) / 2, x1: (first + (i + 1) * tile) / 2, y0: 0, y1: cut / 2 }));
  const below = base.spines.filter((spine) => spine.y1 > cut / 2).map((spine) => ({ ...spine, y0: Math.max(spine.y0, cut / 2) }));
  return { name, width: base.width, height: base.height, pixels, spines: [...copies, ...below] };
}

// Value noise standing in for the room around the shelf, so looking away shows unrelated detail rather than a blank.
export function makeTexture(seed = 7) {
  const out = shared(TEXTURE * TEXTURE);
  const octaves: [number, number][] = [[128, 0.22], [32, 0.12], [8, 0.05]];
  for (const [cell, amplitude] of octaves) {
    const n = TEXTURE / cell;
    const random = mulberry(hash(seed, cell));
    const lattice = Float32Array.from({ length: n * n }, () => random() * 2 - 1);
    const fraction = Float32Array.from({ length: cell }, (_, i) => smooth(i / cell));
    for (let y = 0; y < TEXTURE; y++) {
      const top = Math.floor(y / cell) * n;
      const bottom = ((Math.floor(y / cell) + 1) % n) * n;
      const fy = fraction[y % cell];
      for (let x = 0; x < TEXTURE; x++) {
        const x0 = Math.floor(x / cell);
        const x1 = (x0 + 1) % n;
        const fx = fraction[x % cell];
        const a = lattice[top + x0];
        const b = lattice[top + x1];
        const c = lattice[bottom + x0];
        const d = lattice[bottom + x1];
        out[y * TEXTURE + x] += amplitude * (a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy);
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = Math.min(1, Math.max(0, out[i] + 0.42));
  return out;
}

function smooth(t: number) {
  return t * t * (3 - 2 * t);
}

export function makeScene(source: Source, texture: Float32Array, crop: number): Scene {
  const x0 = crop * (source.width / 2 - FRAME_W);
  const y0 = (source.height / 2 - FRAME_H) / 2;
  return { source, texture, x0, y0, dir: crop < 0.5 ? 1 : -1 };
}

// The rest-pose frame's spines, in rest-frame pixels.
export function sceneSpines(scene: Scene) {
  return scene.source.spines.map((spine) => ({ x0: spine.x0 - scene.x0, x1: spine.x1 - scene.x0, y0: spine.y0 - scene.y0, y1: spine.y1 - scene.y0 }));
}

function sourceMap(scene: Scene, pose: Pose): Mat3 {
  const toSource = [2, 0, 2 * scene.x0 + 0.5, 0, 2, 2 * scene.y0 + 0.5, 0, 0, 1];
  return multiply(toSource, invert(poseMatrix(pose)));
}

function textureAt(texture: Float32Array, u: number, v: number) {
  const fu = u - Math.floor(u);
  const fv = v - Math.floor(v);
  const x0 = Math.floor(u) & (TEXTURE - 1);
  const y0 = Math.floor(v) & (TEXTURE - 1);
  const x1 = (x0 + 1) & (TEXTURE - 1);
  const y1 = (y0 + 1) & (TEXTURE - 1);
  const top = texture[y0 * TEXTURE + x0] * (1 - fu) + texture[y0 * TEXTURE + x1] * fu;
  const bottom = texture[y1 * TEXTURE + x0] * (1 - fu) + texture[y1 * TEXTURE + x1] * fu;
  return top * (1 - fv) + bottom * fv;
}

// 2x2 supersamples per output pixel, mapped through the projective warp one row at a time.
function addRow(sum: Float64Array, scene: Scene, m: Mat3, y: number) {
  const { pixels, width, height } = scene.source;
  const texture = scene.texture;
  const maxU = width - 1;
  const maxV = height - 1;
  const base = y * FRAME_W;
  for (let row = 0; row < 2; row++) {
    const sy = y - 0.25 + row * 0.5;
    let px = m[0] * -0.25 + m[1] * sy + m[2];
    let py = m[3] * -0.25 + m[4] * sy + m[5];
    let pw = m[6] * -0.25 + m[7] * sy + m[8];
    const dx = m[0] * 0.5;
    const dy = m[3] * 0.5;
    const dw = m[6] * 0.5;
    for (let i = 0; i < FRAME_W * 2; i++) {
      const u = px / pw;
      const v = py / pw;
      let value: number;
      if (u >= 0 && v >= 0 && u < maxU && v < maxV) {
        const x0 = u | 0;
        const y0 = v | 0;
        const fu = u - x0;
        const fv = v - y0;
        const index = y0 * width + x0;
        const top = pixels[index] + (pixels[index + 1] - pixels[index]) * fu;
        const bottom = pixels[index + width] + (pixels[index + width + 1] - pixels[index + width]) * fu;
        value = top + (bottom - top) * fv;
      } else {
        value = textureAt(texture, u, v);
      }
      sum[base + (i >> 1)] += value;
      px += dx;
      py += dy;
      pw += dw;
    }
  }
}

function blurSamples(poseAt: (ms: number) => Pose, ms: number, exposureMs: number) {
  if (!exposureMs) return 1;
  const step = multiply(poseMatrix(poseAt(ms + exposureMs / 2)), invert(poseMatrix(poseAt(ms - exposureMs / 2))));
  const corners: [number, number][] = [[0, 0], [FRAME_W - 1, 0], [0, FRAME_H - 1], [FRAME_W - 1, FRAME_H - 1], [CX, CY]];
  const moved = Math.max(...corners.map(([x, y]) => {
    const [u, v] = project(step, x, y);
    return Math.hypot(u - x, v - y);
  }));
  return moved > 0.3 ? 8 : 1;
}

// Sensor model: exposure-long motion blur from 8 sub-frames, optional rolling shutter, gain with clipping, noise, 8-bit output.
export function render(scene: Scene, poseAt: (ms: number) => Pose, ms: number, optics: Optics, seed: number): Float32Array {
  const sum = new Float64Array(FRAME_W * FRAME_H);
  const count = blurSamples(poseAt, ms, optics.exposureMs);
  for (let k = 0; k < count; k++) {
    const t = count === 1 ? ms : ms + optics.exposureMs * ((k + 0.5) / count - 0.5);
    if (!optics.shutterMs) {
      const m = sourceMap(scene, poseAt(t));
      for (let y = 0; y < FRAME_H; y++) addRow(sum, scene, m, y);
    } else {
      for (let y = 0; y < FRAME_H; y++) addRow(sum, scene, sourceMap(scene, poseAt(t + optics.shutterMs * (y / (FRAME_H - 1) - 0.5))), y);
    }
  }
  return develop(sum, 4 * count, poseAt(ms), optics.noise, seed);
}

function develop(sum: Float64Array, samples: number, pose: Pose, noise: number, seed: number) {
  const random = mulberry(seed);
  const out = new Float32Array(sum.length);
  for (let i = 0; i < sum.length; i++) {
    const exposed = Math.min(1, Math.max(0, pose.gain * (sum[i] / samples) + pose.offset));
    const light = exposed * (1 - pose.cover) + COVERED_LEVEL * pose.cover;
    const grain = (random() + random() + random() + random() - 2) * Math.sqrt(3) * noise;
    out[i] = Math.round(Math.min(1, Math.max(0, light + grain)) * 255) / 255;
  }
  return out;
}

export function noiseFrame(seed: number) {
  const random = mulberry(seed);
  return Float32Array.from({ length: FRAME_W * FRAME_H }, () => Math.round(random() * 255) / 255);
}

export function shiftFrame(gray: Float32Array, dx: number, dy: number, seed: number) {
  const fill = noiseFrame(seed);
  const out = new Float32Array(gray.length);
  for (let y = 0; y < FRAME_H; y++) {
    for (let x = 0; x < FRAME_W; x++) {
      const sx = x - dx;
      const sy = y - dy;
      out[y * FRAME_W + x] = sx >= 0 && sy >= 0 && sx < FRAME_W && sy < FRAME_H ? gray[sy * FRAME_W + sx] : fill[y * FRAME_W + x];
    }
  }
  return out;
}

export function grayFrame(gray: Float32Array): GrayFrame {
  return { gray, width: FRAME_W, height: FRAME_H };
}
