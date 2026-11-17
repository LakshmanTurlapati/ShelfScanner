import { applyHomography, composeHomography, invertHomography, type GrayFrame, type Mat3 } from "../../web/src/overlay/track.ts";

// A synthetic bookshelf and a camera over it, shared by the tracker and relocation tests.

export const WIDTH = 480;
export const HEIGHT = 853;

export function random(seed: number) {
  let state = seed;
  return () => (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
}

export type Texture = { img: Float32Array; width: number; height: number };

// Spines of random width and tone, each with a few title-like blocks and bands, lightly blurred.
export function shelf(width: number, height: number, seed: number): Texture {
  const next = random(seed);
  const img = new Float32Array(width * height).fill(0.1);
  const fill = (x0: number, y0: number, w: number, h: number, value: number) => {
    for (let y = Math.max(0, Math.round(y0)); y < Math.min(height, Math.round(y0 + h)); y++) {
      for (let x = Math.max(0, Math.round(x0)); x < Math.min(width, Math.round(x0 + w)); x++) img[y * width + x] = Math.min(1, Math.max(0, value));
    }
  };
  for (let x = 0; x < width;) {
    const w = Math.round(16 + next() * 44);
    const top = height * (0.03 + next() * 0.1);
    const bottom = height * (0.88 + next() * 0.1);
    const tone = 0.25 + next() * 0.55;
    fill(x, top, w, bottom - top, tone);
    for (let block = 4 + Math.floor(next() * 8); block > 0; block--) {
      fill(x + 2 + next() * w * 0.3, top + next() * (bottom - top - 14), w * (0.25 + next() * 0.5), 3 + next() * 10,
        tone + (next() < 0.5 ? -1 : 1) * (0.15 + next() * 0.25));
    }
    fill(x, top + next() * (bottom - top), w, 2 + next() * 3, tone * 0.5);
    x += w + 1 + Math.floor(next() * 3);
  }
  const out = new Float32Array(img.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) sum += img[Math.min(height - 1, Math.max(0, y + dy)) * width + Math.min(width - 1, Math.max(0, x + dx))];
      }
      out[y * width + x] = sum / 9;
    }
  }
  return { img: out, width, height };
}

export type Pose = { x: number; y: number; angle?: number; zoom?: number };

// Frame pixel to texture pixel for a camera centred on (x, y) of the texture.
export function poseMatrix(pose: Pose): Mat3 {
  const angle = ((pose.angle ?? 0) * Math.PI) / 180;
  const c = Math.cos(angle) / (pose.zoom ?? 1);
  const s = Math.sin(angle) / (pose.zoom ?? 1);
  return [c, -s, pose.x - c * WIDTH / 2 + s * HEIGHT / 2, s, c, pose.y - s * WIDTH / 2 - c * HEIGHT / 2, 0, 0, 1];
}

export function render(texture: Texture, pose: Pose, look: { gain?: number; offset?: number; seed?: number } = {}): GrayFrame {
  const h = poseMatrix(pose);
  const noise = random(look.seed ?? 1);
  const gray = new Float32Array(WIDTH * HEIGHT);
  const { img, width, height } = texture;
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = applyHomography(h, x, y);
      const px = Math.min(width - 1.001, Math.max(0, p.x));
      const py = Math.min(height - 1.001, Math.max(0, p.y));
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const at = y0 * width + x0;
      const fx = px - x0;
      const fy = py - y0;
      const value = (img[at] * (1 - fx) + img[at + 1] * fx) * (1 - fy) + (img[at + width] * (1 - fx) + img[at + width + 1] * fx) * fy;
      gray[y * WIDTH + x] = Math.round(Math.min(1, Math.max(0, value * (look.gain ?? 1) + (look.offset ?? 0) + (noise() - 0.5) * 0.016)) * 255) / 255;
    }
  }
  return { gray, width: WIDTH, height: HEIGHT };
}

export function truth(key: Pose, pose: Pose) {
  return composeHomography(invertHomography(poseMatrix(pose)), poseMatrix(key));
}

// Worst error over a 3x3 grid of the current view.
export function viewError(estimate: Mat3, actual: Mat3) {
  const back = invertHomography(actual);
  let worst = 0;
  for (const gx of [0.15, 0.5, 0.85]) {
    for (const gy of [0.15, 0.5, 0.85]) {
      const k = applyHomography(back, gx * WIDTH, gy * HEIGHT);
      const p = applyHomography(estimate, k.x, k.y);
      worst = Math.max(worst, Math.hypot(p.x - gx * WIDTH, p.y - gy * HEIGHT));
    }
  }
  return worst;
}

export function repeated(texture: Texture, period: number): Texture {
  const img = new Float32Array(texture.img.length);
  for (let y = 0; y < texture.height; y++) {
    for (let x = 0; x < texture.width; x++) img[y * texture.width + x] = texture.img[y * texture.width + (x % period)];
  }
  return { ...texture, img };
}
