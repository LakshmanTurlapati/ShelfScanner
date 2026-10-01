import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { build } from "esbuild";
import { percentile, type CpuRate, type CpuSummary } from "./report.ts";
import { FRAME_H, FRAME_W } from "./scene.ts";

const BASELINE_TRACKER = ".context/tracking/track-baseline.ts";
const BASELINE_WORKER = ".context/tracking/tracking.worker-baseline.ts";
const RATES = [1, 4, 6];
const PASSES = 2;

async function bundle(entry: string, tracker: string, options: { minify: boolean; format: "iife" | "esm"; globalName?: string }) {
  const result = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    write: false,
    platform: "browser",
    target: "es2022",
    logLevel: "silent",
    ...options,
    plugins: [{ name: "tracker", setup: (b) => b.onResolve({ filter: /^\.\/track(\.ts)?$/ }, () => ({ path: resolve(tracker) })) }],
  });
  return result.outputFiles[0].text;
}

const gzipped = (code: string) => gzipSync(Buffer.from(code), { level: 9 }).length;

function workerNextTo(tracker: string) {
  return ["tracking.worker.ts", "tracking.worker-baseline.ts"].map((name) => join(dirname(tracker), name)).find(existsSync) ?? null;
}

async function bundleSizes(tracker: string): Promise<CpuSummary["bundle"]> {
  const worker = workerNextTo(tracker);
  const workerGzip = worker ? gzipped(await bundle(worker, tracker, { minify: true, format: "esm" })) : null;
  const baselineWorkerGzip = gzipped(await bundle(BASELINE_WORKER, BASELINE_TRACKER, { minify: true, format: "esm" }));
  return {
    trackerGzip: gzipped(await bundle(tracker, tracker, { minify: true, format: "esm" })),
    workerGzip,
    baselineWorkerGzip,
    deltaGzip: workerGzip === null ? null : workerGzip - baselineWorkerGzip,
  };
}

type PageWindow = { benchFrames?: Float32Array[]; BenchTracker?: Record<string, (...args: unknown[]) => unknown> };

function storeFrames({ list, fresh }: { list: string[]; fresh: boolean }) {
  const page = globalThis as unknown as PageWindow;
  if (fresh || !page.benchFrames) page.benchFrames = [];
  for (const encoded of list) {
    const bytes = atob(encoded);
    const gray = new Float32Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) gray[i] = bytes.charCodeAt(i) / 255;
    page.benchFrames.push(gray);
  }
}

// Runs in the page: begin on the first frame, then step through the rest, as the worker would.
function timePasses({ passes, width, height }: { passes: number; width: number; height: number }) {
  const page = globalThis as unknown as PageWindow;
  const tracker = page.BenchTracker!;
  const frames = page.benchFrames!.map((gray) => ({ gray, width, height }));
  const steps: number[] = [];
  const begins: number[] = [];
  for (let pass = 0; pass < passes; pass++) {
    let start = performance.now();
    const began = tracker.beginTrack(frames[0], 0) as Record<string, unknown> | null;
    begins.push(performance.now() - start);
    let state: unknown = began && "ok" in began && "state" in began ? began.state : began;
    if (!state) continue;
    for (let i = 1; i < frames.length; i++) {
      start = performance.now();
      const result = tracker.stepTrack(state, frames[i], { t: i * 100 }) as { state?: unknown };
      steps.push(performance.now() - start);
      state = result.state ?? state;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4).map((_, i) => (i * 37) & 255);
  const start = performance.now();
  tracker.grayFromRGBA(rgba, width, height);
  return { steps, begins, grayMs: performance.now() - start };
}

export type CpuSequence = { sequence: string; frames: Float32Array[] };

// CDP throttling slows only the page's main thread, so the tracker runs there rather than in a worker.
export async function measureCpu(tracker: string, sequences: CpuSequence[]): Promise<CpuSummary> {
  const code = await bundle(tracker, tracker, { minify: false, format: "iife", globalName: "BenchTracker" });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.addScriptTag({ content: code });
    const cdp = await page.context().newCDPSession(page);
    const measured: CpuSummary["sequences"] = [];
    for (const { sequence, frames } of sequences) {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
      for (let i = 0; i < frames.length; i += 8) {
        const list = frames.slice(i, i + 8).map((gray) => Buffer.from(Uint8Array.from(gray, (value) => Math.round(value * 255))).toString("base64"));
        await page.evaluate(storeFrames, { list, fresh: i === 0 });
      }
      await page.evaluate(timePasses, { passes: 1, width: FRAME_W, height: FRAME_H });
      const rates: CpuRate[] = [];
      for (const rate of RATES) {
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
        const timing = await page.evaluate(timePasses, { passes: PASSES, width: FRAME_W, height: FRAME_H });
        rates.push({
          rate,
          steps: timing.steps.length,
          p50: percentile(timing.steps, 0.5),
          p90: percentile(timing.steps, 0.9),
          max: Math.max(...timing.steps),
          beginMs: percentile(timing.begins, 0.5),
          grayMs: timing.grayMs,
        });
      }
      measured.push({ sequence, rates });
    }
    return { sequences: measured, bundle: await bundleSizes(tracker) };
  } finally {
    await browser.close();
  }
}
