import { writeFileSync } from "node:fs";
import { availableParallelism, cpus } from "node:os";
import { parseArgs } from "node:util";
import { Worker } from "node:worker_threads";
import { measureCpu, type CpuSequence } from "./track-bench/cpu.ts";
import { LOOKALIKE_PROFILES, PROFILES, profileNamed, REPEAT_PROFILES } from "./track-bench/profiles.ts";
import { formatMarkdown, formatText, percentile, STAGE_ONE_SETS, stageOneBars, summarise, type CpuSummary, type Summary } from "./track-bench/report.ts";
import { decodeGolden, grayFrame, makeScene, makeTexture, render, REST, tileRows, tileSource } from "./track-bench/scene.ts";
import { loadTracker, type Job, type Result, type World } from "./track-bench/sim.ts";

const USAGE = `Usage: npm run eval:track -- [options]
  --tracker <path>   tracker module (default web/src/overlay/track.ts); old and new beginTrack/stepTrack APIs both work
  --profiles a,b     profiles, groups (everyday, stress, event) or sets (sweep, drift, repeat, lookalike, unrelated); default all
  --cadence 66|100   sampling interval in ms (default 100)
  --full             2 seeds for everything (default 1 seed)
  --seeds n          number of seeds
  --stage 1          run the Stage 1 sets (look-alike shelves included) with 2 seeds plus --cpu, check the pass bars, exit 1 on a miss
  --skip-cpu         with --stage, skip the Chromium timing
  --cpu              only time the tracker in Chromium (1x/4x/6x CPU throttling on walk, shake and pan60) and report bundle sizes
  --json <file>      write the summary as JSON
  --md <file>        write the tables as Markdown
  --slowdown k       phone speed relative to this machine, for the worker busy flag (default 4)
  --workers n        parallel simulation threads`;

const PHOTOS = ["crai-spines-17", "old-books-bookshelf"];
const TILED = "crai-spines-17-tiled";
// One old-books spine repeated every 34 px and every 58 px of the frame, and the 58 px one across
// only the upper half of the photo, so part of the view is unique.
const LOOKALIKES = ["old-books-p34", "old-books-p58", "old-books-half58"];
const CROPS = [0.3, 0.6];
const SETS = ["sweep", "drift", "repeat", "lookalike", "unrelated"];
const GROUPS = ["everyday", "stress", "event"];
const CPU_SEQUENCES = ["walk", "shake", "pan60"];

const { values } = parseArgs({
  options: {
    tracker: { type: "string", default: "web/src/overlay/track.ts" },
    profiles: { type: "string" },
    cadence: { type: "string", default: "100" },
    full: { type: "boolean", default: false },
    seeds: { type: "string" },
    stage: { type: "string" },
    "skip-cpu": { type: "boolean", default: false },
    cpu: { type: "boolean", default: false },
    json: { type: "string" },
    md: { type: "string" },
    slowdown: { type: "string", default: "4" },
    workers: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

function selection(list: string | undefined, stage: boolean) {
  const names = list
    ? list.split(",").flatMap((name) => (GROUPS.includes(name) ? PROFILES.filter((item) => item.group === name).map((item) => item.name) : [name]))
    : [...PROFILES.map((item) => item.name), ...SETS];
  const all = new Set([...names, ...(stage ? STAGE_ONE_SETS : [])]);
  for (const name of all) if (!SETS.includes(name)) profileNamed(name);
  return all;
}

function loadWorld(): World {
  const [crai, books] = PHOTOS.map(decodeGolden);
  const sources = [
    crai,
    books,
    tileSource(crai, 0.213, 0.401, 6, TILED),
    tileSource(books, 0.252, 0.272, 40, LOOKALIKES[0]),
    tileSource(books, 0.218, 0.252, 24, LOOKALIKES[1]),
    tileRows(books, 0.218, 0.252, 0.5, LOOKALIKES[2]),
  ];
  return { sources: Object.fromEntries(sources.map((source) => [source.name, source])), texture: makeTexture() };
}

function jobsFor(names: Set<string>, seeds: number[], cadence: number, slowdown: number): Job[] {
  const places = (sources: string[]) => sources.flatMap((source) => CROPS.flatMap((crop) => seeds.map((seed) => ({ source, crop, seed }))));
  const jobs: Job[] = [];
  for (const profile of PROFILES.filter((item) => names.has(item.name))) {
    for (const place of places(PHOTOS)) jobs.push({ kind: "seq", profile: profile.name, cadence, slowdown, ...place });
  }
  if (names.has("repeat")) for (const profile of REPEAT_PROFILES) for (const place of places([TILED])) jobs.push({ kind: "seq", profile, cadence, slowdown, set: "repeat", ...place });
  if (names.has("lookalike")) {
    for (const profile of LOOKALIKE_PROFILES) for (const place of places(LOOKALIKES)) jobs.push({ kind: "seq", profile, cadence, slowdown, set: "lookalike", ...place });
  }
  for (const kind of ["sweep", "drift", "unrelated"] as const) if (names.has(kind)) for (const place of places(PHOTOS)) jobs.push({ kind, ...place });
  const cost = (job: Job) => (job.kind === "seq" ? profileNamed(job.profile).seconds : job.kind === "drift" ? 40 : 4);
  return jobs.sort((a, b) => cost(b) - cost(a));
}

function runPool(jobs: Job[], trackerPath: string, world: World, threads: number) {
  const results: Result[] = [];
  const workers: Worker[] = [];
  let next = 0;
  const run = () => new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL("./track-bench/worker.ts", import.meta.url), { workerData: { trackerPath, world } });
    workers.push(worker);
    worker.on("error", reject);
    worker.on("message", (message: { result?: Result; error?: string }) => {
      if (message.error) return reject(new Error(message.error));
      if (message.result) {
        results.push(message.result);
        process.stderr.write(`\r${results.length}/${jobs.length} runs`);
      }
      if (next < jobs.length) worker.postMessage(jobs[next++]);
      else void worker.terminate().then(() => resolve());
    });
  });
  return Promise.all(Array.from({ length: Math.min(threads, jobs.length) }, run))
    .then(() => {
      process.stderr.write("\n");
      return results;
    })
    .catch((error: unknown) => {
      for (const worker of workers) void worker.terminate();
      throw error;
    });
}

async function probeApi(trackerPath: string, world: World) {
  const tracker = await loadTracker(trackerPath);
  const scene = makeScene(world.sources[PHOTOS[0]], world.texture, 0.3);
  tracker.begin(grayFrame(render(scene, () => REST, 0, { exposureMs: 0, shutterMs: 0, noise: 0.008 }, 1)), 0);
  return tracker.api;
}

// Up to 61 frames 100 ms apart from each sequence on old-books at crop 0.3.
function cpuSequences(world: World): CpuSequence[] {
  const scene = makeScene(world.sources["old-books-bookshelf"], world.texture, 0.3);
  return CPU_SEQUENCES.map((name) => {
    const profile = profileNamed(name);
    const poseAt = profile.make(1, scene.dir);
    const count = Math.min(61, Math.floor(profile.seconds * 10) + 1);
    return { sequence: name, frames: Array.from({ length: count }, (_, i) => render(scene, poseAt, i * 100, profile.optics, i + 1)) };
  });
}

function compactRuns(results: Result[]) {
  return results.map((result) => {
    if (result.kind !== "seq") return result;
    const { errors, stepMs, display, ...rest } = result;
    return {
      ...rest,
      accepted: errors.length,
      errorP95: errors.length ? percentile(errors, 0.95) : null,
      errorMax: errors.length ? Math.max(...errors) : null,
      stepP50: stepMs.length ? percentile(stepMs, 0.5) : null,
      displayP95: display.length ? percentile(display, 0.95) : null,
    };
  });
}

async function main() {
  if (values.help) return console.log(USAGE);
  if (values.stage && values.stage !== "1") throw new Error("Only --stage 1 has pass bars so far.");
  const started = performance.now();
  const stage = values.stage === "1";
  const cadence = Number(values.cadence);
  const slowdown = Number(values.slowdown);
  const seedCount = values.seeds ? Number(values.seeds) : values.full || stage ? 2 : 1;
  const seeds = Array.from({ length: seedCount }, (_, i) => i + 1);
  const threads = values.workers ? Number(values.workers) : Math.max(1, Math.min(12, availableParallelism() - 2));
  const simulate = !values.cpu || stage;
  const names = selection(values.profiles, stage);
  const world = loadWorld();
  const api = await probeApi(values.tracker, world);
  const results = simulate ? await runPool(jobsFor(names, seeds, cadence, slowdown), values.tracker, world, threads) : [];
  const summary: Summary = summarise(results);
  const cpu: CpuSummary | null = values.cpu || (stage && !values["skip-cpu"]) ? await measureCpu(values.tracker, cpuSequences(world)) : null;
  const bars = stage ? stageOneBars(summary, cpu) : null;
  const seconds = (performance.now() - started) / 1000;
  const header = [
    `Tracker ${values.tracker} (${api} API)`,
    simulate ? `${cadence} ms cadence, ${seeds.length} seed(s) x 2 photos x 2 crops, phone slowdown ${slowdown}x` : null,
    `${seconds.toFixed(0)} s on ${cpus()[0]?.model ?? "unknown CPU"}`,
  ].filter(Boolean).join("; ");
  console.log(`${header}\n\n${formatText(summary, bars, cpu)}`);
  const meta = { tracker: values.tracker, api, cadence, seeds: seeds.length, slowdown, seconds, date: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model };
  if (values.json) writeFileSync(values.json, `${JSON.stringify({ meta, summary, cpu, bars, runs: compactRuns(results) }, null, 2)}\n`);
  if (values.md) writeFileSync(values.md, `${header}\n\n${formatMarkdown(summary, bars, cpu)}\n`);
  if (bars?.some((bar) => bar.pass === false)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exit(2);
});
