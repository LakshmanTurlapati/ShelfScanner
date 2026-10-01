import { describe, expect, it } from "vitest";
import {
  alignToKeyframe,
  applyHomography,
  beginTrack,
  buildPyramid,
  composeHomography,
  extrapolateHomography,
  fitHomography,
  IDENTITY,
  invertHomography,
  stepTrack,
  type GrayFrame,
  type Mat3,
  type TrackState,
} from "../web/src/overlay/track.ts";

const WIDTH = 480;
const HEIGHT = 853;

function random(seed: number) {
  let state = seed;
  return () => (state = (Math.imul(1664525, state) + 1013904223) >>> 0) / 4294967296;
}

type Texture = { img: Float32Array; width: number; height: number };

// Spines of random width and tone, each with a few title-like blocks and bands, lightly blurred.
function shelf(width: number, height: number, seed: number): Texture {
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

type Pose = { x: number; y: number; angle?: number; zoom?: number };

// Frame pixel to texture pixel for a camera centred on (x, y) of the texture.
function poseMatrix(pose: Pose): Mat3 {
  const angle = ((pose.angle ?? 0) * Math.PI) / 180;
  const c = Math.cos(angle) / (pose.zoom ?? 1);
  const s = Math.sin(angle) / (pose.zoom ?? 1);
  return [c, -s, pose.x - c * WIDTH / 2 + s * HEIGHT / 2, s, c, pose.y - s * WIDTH / 2 - c * HEIGHT / 2, 0, 0, 1];
}

function render(texture: Texture, pose: Pose, look: { gain?: number; offset?: number; seed?: number } = {}): GrayFrame {
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

function truth(key: Pose, pose: Pose) {
  return composeHomography(invertHomography(poseMatrix(pose)), poseMatrix(key));
}

// Worst error over a 3x3 grid of the current view.
function viewError(estimate: Mat3, actual: Mat3) {
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

function start(seed: number, wide = 3) {
  const texture = shelf(WIDTH * wide, HEIGHT + 200, seed);
  const key: Pose = { x: WIDTH * 1.2, y: (HEIGHT + 200) / 2 };
  const begun = beginTrack(render(texture, key), 0);
  expect(begun.ok).toBe(true);
  return { texture, key, state: begun.state! };
}

// Steps through every pose at 100 ms intervals; returns the last state and every step's error.
function follow(texture: Texture, key: Pose, state: TrackState, poses: Pose[]) {
  const errors: number[] = [];
  poses.forEach((pose, index) => {
    const step = stepTrack(state, render(texture, pose, { seed: index + 2 }), { t: (index + 1) * 100 });
    errors.push(step.homography ? viewError(step.homography, truth(key, pose)) : Infinity);
    if (step.steady) state = step.state;
  });
  return { state, errors };
}

describe("tracker core", () => {
  it("tracks a 24 px shift from a standing start", () => {
    const { texture, key, state } = start(1);
    const pose = { ...key, x: key.x - 24 };
    const step = stepTrack(state, render(texture, pose), { t: 100 });
    expect(step.steady).toBe(true);
    expect(viewError(step.homography!, truth(key, pose))).toBeLessThan(0.5);
  });

  it("follows 30 steps of 25 px", { timeout: 30_000 }, () => {
    const { texture, key, state } = start(2);
    const { errors } = follow(texture, key, state, Array.from({ length: 30 }, (_, i) => ({ ...key, x: key.x + 25 * (i + 1) })));
    expect(Math.max(...errors)).toBeLessThan(1);
  });

  it.each<[string, Partial<Pose>, { gain?: number; offset?: number }]>([
    ["a 5 degree roll", { angle: 5 }, {}],
    ["a 1.08x zoom", { zoom: 1.08 }, {}],
    ["a darker exposure", { x: 12 }, { gain: 0.6 }],
    ["a brighter exposure", { x: 12 }, { gain: 1.4 }],
    ["a brightness offset", { x: 12 }, { offset: 0.1 }],
  ])("accepts %s in one step", (_, change, look) => {
    const { texture, key, state } = start(3);
    const pose = { ...key, ...change, x: key.x + (change.x ?? 0) };
    const step = stepTrack(state, render(texture, pose, look), { t: 100 });
    expect(step.steady).toBe(true);
    expect(viewError(step.homography!, truth(key, pose))).toBeLessThan(1);
  });

  it("pans a frame and a half away and back with points added on the way", { timeout: 60_000 }, () => {
    const { texture, key, state } = start(4, 4);
    const out = Array.from({ length: 36 }, (_, i) => ({ ...key, x: key.x + 20 * (i + 1) }));
    const poses = [...out, ...out.slice(0, -1).reverse(), key];
    const result = follow(texture, key, state, poses);
    expect(result.state.points.some((point) => point.added)).toBe(true);
    expect(result.errors.at(-1)).toBeLessThan(3);
    expect(result.errors.filter((error) => error > 3)).toHaveLength(0);
  });

  it("ends 120 random hand-held steps without drifting", { timeout: 60_000 }, () => {
    const { texture, key, state } = start(5);
    const next = random(99);
    const poses: Pose[] = [];
    let pose: Required<Pose> = { ...key, angle: 0, zoom: 1 };
    for (let i = 0; i < 120; i++) {
      pose = {
        x: pose.x + (next() - 0.5) * 16,
        y: pose.y + (next() - 0.5) * 16,
        angle: pose.angle + (next() - 0.5) * 1.5,
        zoom: pose.zoom * (1 + (next() - 0.5) * 0.03),
      };
      poses.push(pose);
    }
    const { errors } = follow(texture, key, state, poses);
    expect(errors.at(-1)).toBeLessThan(1);
  });

  it("anchors to the keyframe only from a close guess", () => {
    const { texture, key, state } = start(6);
    const pose = { ...key, x: key.x + 30, y: key.y - 10, angle: 2 };
    const actual = truth(key, pose);
    const frame = buildPyramid(render(texture, pose));
    const close = alignToKeyframe(state, frame, composeHomography([1, 0, 2, 0, 1, -1.5, 0, 0, 1], actual));
    expect(close.h).not.toBeNull();
    expect(viewError(close.h!, actual)).toBeLessThan(0.5);
    expect(alignToKeyframe(state, frame, composeHomography([1, 0, 7, 0, 1, 0, 0, 0, 1], actual)).h).toBeNull();
    expect(alignToKeyframe(state, frame, composeHomography([1, 0, -5, 0, 1, 6, 0, 0, 1], actual)).h).toBeNull();
  });

  it("counts keyframe corners it cannot find against the keyframe match", () => {
    const { texture, key, state } = start(10);
    const frame = render(texture, key);
    const split = Math.round(HEIGHT * 0.4) * WIDTH;
    frame.gray.set(render(shelf(WIDTH * 3, HEIGHT + 200, 71), key).gray.subarray(split), split);
    const anchored = alignToKeyframe(state, buildPyramid(frame), IDENTITY);
    expect(anchored.tried).toBeGreaterThanOrEqual(30);
    expect(anchored.inliers).toBeGreaterThanOrEqual(15);
    expect(anchored.h).toBeNull();
  });

  it("refuses an unrelated shelf and keeps its state", () => {
    const { key, state } = start(7);
    const step = stepTrack(state, render(shelf(WIDTH * 3, HEIGHT + 200, 70), key), { t: 100 });
    expect(step.steady).toBe(false);
    expect(step.homography).toBeNull();
    expect(step.state).toBe(state);
  });

  it("calls a blank view a hard failure", () => {
    const { state } = start(8);
    const step = stepTrack(state, { gray: new Float32Array(WIDTH * HEIGHT).fill(0.5), width: WIDTH, height: HEIGHT }, { t: 100 });
    expect(step.steady).toBe(false);
    expect(step.hard).toBe(true);
  });

  it("will not start on a frame without detail", () => {
    const begun = beginTrack({ gray: new Float32Array(WIDTH * HEIGHT).fill(0.5), width: WIDTH, height: HEIGHT }, 0);
    expect(begun.ok).toBe(false);
    expect(begun.state).toBeNull();
  });

  it("keeps up with a fast pan once it knows the velocity", { timeout: 30_000 }, () => {
    const { texture, key, state } = start(9, 5);
    const offsets = [15, 45, 90, 150, 210, 270, 330, 390, 450, 510];
    const { errors } = follow(texture, key, state, offsets.map((offset) => ({ ...key, x: key.x + offset })));
    expect(Math.max(...errors)).toBeLessThan(1);
  });
});

// One stretch of shelf `period` px wide, repeated across it, so every spine has look-alikes.
function repeated(texture: Texture, period: number): Texture {
  const img = new Float32Array(texture.img.length);
  for (let y = 0; y < texture.height; y++) {
    for (let x = 0; x < texture.width; x++) img[y * texture.width + x] = texture.img[y * texture.width + (x % period)];
  }
  return { ...texture, img };
}

describe("look-alike spines", () => {
  const PERIOD = 40;

  function startRepeated(seed: number) {
    const texture = repeated(shelf(WIDTH * 3, HEIGHT + 200, seed), PERIOD);
    const key: Pose = { x: WIDTH * 1.2, y: (HEIGHT + 200) / 2 };
    const begun = beginTrack(render(texture, key), 0);
    expect(begun.ok).toBe(true);
    return { texture, key, state: begun.state! };
  }

  it("keeps tracking a camera held still", () => {
    const { texture, key, state } = startRepeated(11);
    const { errors } = follow(texture, key, state, [1, 2, 2, 1, 0].map((dx) => ({ ...key, x: key.x + dx, y: key.y - dx })));
    expect(Math.max(...errors)).toBeLessThan(0.5);
  });

  it("stops at a fast move and does not pick a copy afterwards", () => {
    const { texture, key, state } = startRepeated(12);
    const moved = { ...key, x: key.x + PERIOD * 0.75 };
    const poses = [moved, moved, { ...moved, x: moved.x + 1 }, moved];
    let current = state;
    poses.forEach((pose, index) => {
      const step = stepTrack(current, render(texture, pose, { seed: index + 2 }), { t: (index + 1) * 100 });
      expect(step.reason).toBe("look-alike");
      current = step.state;
    });
  });

  it("does not run away when the last step moved one spine but the camera is still", () => {
    const { texture, key, state } = startRepeated(13);
    const fast: TrackState = { ...state, velocity: { h: [1, 0, PERIOD, 0, 1, 0, 0, 0, 1], dt: 100 } };
    const { errors } = follow(texture, key, fast, Array.from({ length: 8 }, () => key));
    expect(errors.filter((error) => error < Infinity && error > 1)).toHaveLength(0);
  });

  it("refuses a pose one spine off where only the upper half repeats", () => {
    const base = shelf(WIDTH * 3, HEIGHT + 200, 14);
    const top = repeated(base, PERIOD).img;
    const cut = Math.round((HEIGHT + 200) / 2) * base.width;
    const texture = { ...base, img: base.img.map((value, i) => (i < cut ? top[i] : value)) };
    const key: Pose = { x: WIDTH * 1.2, y: (HEIGHT + 200) / 2 };
    const frame = render(texture, key);
    const { state } = beginTrack(frame, 0);
    const off: TrackState = { ...state!, keyToRef: [1, 0, PERIOD, 0, 1, 0, 0, 0, 1] };
    expect(stepTrack(off, frame, { t: 100 }).reason).toBe("look-alike");
    expect(stepTrack(state!, frame, { t: 100 }).steady).toBe(true);
  });
});

describe("homography helpers", () => {
  it("inverts and extrapolates a motion", () => {
    const h: Mat3 = [1.02, -0.03, 12, 0.03, 1.02, -5, 0.00001, 0, 1];
    const round = composeHomography(h, invertHomography(h));
    const p = applyHomography(round, 200, 300);
    expect(p.x).toBeCloseTo(200, 6);
    expect(p.y).toBeCloseTo(300, 6);
    const shift = extrapolateHomography({ h: [1, 0, 10, 0, 1, -4, 0, 0, 1], dt: 100 }, 250);
    expect(applyHomography(shift, 0, 0)).toEqual({ x: 25, y: -10 });
  });

  it("fits through outliers and falls back to a similarity with few points", () => {
    const h: Mat3 = [0.98, -0.05, 20, 0.05, 0.98, -8, 0.00002, -0.00001, 1];
    const next = random(5);
    const src: [number, number][] = [];
    const dst: [number, number][] = [];
    for (let i = 0; i < 60; i++) {
      const x = next() * 480;
      const y = next() * 850;
      const p = applyHomography(h, x, y);
      src.push([x, y]);
      dst.push(i % 5 === 0 ? [p.x + 30 * next() + 5, p.y - 20] : [p.x + (next() - 0.5) * 0.2, p.y + (next() - 0.5) * 0.2]);
    }
    const fit = fitHomography(src, dst)!;
    expect(fit.inliers).toBe(48);
    expect(fit.rms).toBeLessThan(0.2);
    const small = fitHomography(src.slice(1, 13), dst.slice(1, 13))!;
    expect([small.h[6], small.h[7]]).toEqual([0, 0]);
  });
});
