import { describe, expect, it } from "vitest";
import { createAutoRead, type AutoReadGate } from "../web/src/overlay/auto-read.ts";
import { createSteadyDetector, sharpness, texture } from "../web/src/overlay/steady.ts";
import type { GrayFrame } from "../web/src/overlay/track.ts";

const WIDTH = 96;
const HEIGHT = 72;

// Spines of varied shades with title strokes, slid sideways by `shift` pixels.
function shelf(shift = 0): GrayFrame {
  const gray = new Float32Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const spine = Math.floor((x + shift) / 6);
      const stroke = y % 12 < 2 && (x + shift) % 6 > 1 ? 0.3 : 0;
      gray[y * WIDTH + x] = Math.min(1, 0.15 + ((spine * 37) % 10) / 10 * 0.7 + stroke);
    }
  }
  return { gray, width: WIDTH, height: HEIGHT };
}

function uniform(): GrayFrame {
  return { gray: new Float32Array(WIDTH * HEIGHT).fill(0.5), width: WIDTH, height: HEIGHT };
}

function boxBlur(frame: GrayFrame, radius: number): GrayFrame {
  const { width, height } = frame;
  const pass = (source: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(source.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        for (let k = -radius; k <= radius; k++) {
          const sx = Math.min(width - 1, Math.max(0, x + k * dx));
          const sy = Math.min(height - 1, Math.max(0, y + k * dy));
          sum += source[sy * width + sx];
        }
        out[y * width + x] = sum / (2 * radius + 1);
      }
    }
    return out;
  };
  return { gray: pass(pass(frame.gray, 1, 0), 0, 1), width, height };
}

function feedAll(frames: (t: number) => GrayFrame, until = 1000) {
  const detector = createSteadyDetector();
  const readings = [];
  for (let t = 0; t <= until; t += 100) readings.push({ t, ...detector.feed(frames(t), t) });
  return readings;
}

describe("steady camera", () => {
  it("calls a still textured view steady once it has held for half a second", () => {
    const readings = feedAll(() => shelf());
    expect(readings.filter((reading) => reading.t < 500).every((reading) => !reading.steady)).toBe(true);
    expect(readings.filter((reading) => reading.t >= 500).every((reading) => reading.steady)).toBe(true);
  });

  it("never calls a moving view steady", () => {
    const readings = feedAll((t) => shelf(t / 50), 3000);
    expect(readings.some((reading) => reading.steady)).toBe(false);
    expect(Math.min(...readings.slice(1).map((reading) => reading.diff))).toBeGreaterThan(0.015);
  });

  it("judges focus and texture the same in dim light and on flat shelves", () => {
    const dim = { ...shelf(), gray: shelf().gray.map((value) => value * 0.4) };
    expect(sharpness(dim)).toBeCloseTo(sharpness(shelf()), 5);
    expect(texture(dim)).toBeCloseTo(texture(shelf()), 5);
    expect(feedAll(() => dim).at(-1)?.steady).toBe(true);
  });

  it("never calls a blank view steady", () => {
    const readings = feedAll(uniform, 3000);
    expect(readings.some((reading) => reading.steady)).toBe(false);
    expect(texture(uniform())).toBe(0);
  });

  it("never calls a blurred view steady, even one that still has edges", () => {
    const sharp = shelf();
    const blurred = boxBlur(sharp, 2);
    expect(texture(blurred)).toBeGreaterThan(0.05);
    expect(sharpness(blurred)).toBeLessThan(sharpness(sharp) / 4);
    expect(feedAll(() => blurred, 3000).some((reading) => reading.steady)).toBe(false);
    expect(feedAll(() => boxBlur(sharp, 3), 3000).some((reading) => reading.steady)).toBe(false);
  });

  it("starts over after motion or a long gap between samples", () => {
    const detector = createSteadyDetector();
    for (let t = 0; t <= 600; t += 100) detector.feed(shelf(), t);
    expect(detector.feed(shelf(), 700).steady).toBe(true);
    expect(detector.feed(shelf(3), 800).steady).toBe(false);
    for (let t = 900; t <= 1200; t += 100) expect(detector.feed(shelf(3), t).steady).toBe(false);
    expect(detector.feed(shelf(3), 1300).steady).toBe(true);
    expect(detector.feed(shelf(3), 5000).steady).toBe(false);
  });
});

describe("auto-read", () => {
  const ready: AutoReadGate = { enabled: true, steady: true, reading: false, visible: true, covered: false, sheetOpen: false, now: 10_000 };
  const view = shelf();
  const elsewhere = shelf(30);

  it("reads a steady view only when nothing else is in the way", () => {
    const auto = createAutoRead();
    expect(auto.due(ready, view)).toBe(true);
    for (const blocked of [{ enabled: false }, { steady: false }, { reading: true }, { visible: false }, { covered: true }, { sheetOpen: true }]) {
      expect(auto.due({ ...ready, ...blocked }, view)).toBe(false);
    }
  });

  it("waits three seconds between reads", () => {
    const auto = createAutoRead();
    auto.started(10_000, view);
    auto.finished(true, false, 11_000);
    expect(auto.due({ ...ready, now: 12_000 }, view)).toBe(false);
    expect(auto.due({ ...ready, now: 13_000 }, view)).toBe(true);
  });

  it("reads a new view at once but the labelled view it just read only after a while", () => {
    const auto = createAutoRead();
    auto.started(10_000, view);
    auto.finished(true, true, 11_000);
    expect(auto.due({ ...ready, now: 14_000 }, view)).toBe(false);
    expect(auto.due({ ...ready, now: 14_000 }, elsewhere)).toBe(true);
    expect(auto.due({ ...ready, now: 19_000 }, view)).toBe(true);
  });

  it("pauses after five reads in a row that found nothing or repeated the same view", () => {
    const auto = createAutoRead();
    let now = 10_000;
    auto.started(now, view);
    auto.finished(true, true, now);
    for (let repeat = 0; repeat < 5; repeat++) {
      now += 8_000;
      expect(auto.due({ ...ready, now }, view)).toBe(true);
      auto.started(now, view);
      auto.finished(true, repeat % 2 === 0, now);
    }
    expect(auto.paused()).toBe(true);
    expect(auto.due({ ...ready, now: now + 60_000 }, elsewhere)).toBe(false);
    auto.resume();
    expect(auto.due({ ...ready, now: now + 60_000 }, elsewhere)).toBe(true);
  });

  it("a labelled read of a new view clears the misses, and taps never count", () => {
    const auto = createAutoRead();
    for (let miss = 0; miss < 4; miss++) {
      auto.started(10_000 + miss * 3000, view);
      auto.finished(true, false, 10_000 + miss * 3000);
    }
    auto.started(30_000, view);
    auto.finished(false, false, 30_000);
    expect(auto.paused()).toBe(false);
    auto.started(40_000, elsewhere);
    auto.finished(true, true, 40_000);
    for (let miss = 0; miss < 4; miss++) {
      auto.started(50_000 + miss * 3000, view);
      auto.finished(true, false, 50_000 + miss * 3000);
    }
    expect(auto.paused()).toBe(false);
  });
});
