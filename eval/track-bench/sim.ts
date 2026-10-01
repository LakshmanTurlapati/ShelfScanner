import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { DRIFT_STEPS, driftPath, profileNamed, SWEEP } from "./profiles.ts";
import {
  FRAME_H,
  FRAME_W,
  grayFrame,
  hash,
  inView,
  invert,
  makeScene,
  multiply,
  noiseFrame,
  poseMatrix,
  project,
  render,
  REST,
  sceneSpines,
  shiftFrame,
  type GrayFrame,
  type Mat3,
  type Optics,
  type Pose,
  type Scene,
  type Source,
  type Spine,
} from "./scene.ts";

export type Api = "old" | "new";
export type World = { sources: Record<string, Source>; texture: Float32Array };
type Outcome = { state: unknown; accepted: boolean; tentative: boolean; homography: Mat3 | null; reason: string | null };
export type Tracker = {
  api: Api;
  begin(frame: GrayFrame, ms: number): { state: unknown; ok: boolean };
  step(state: unknown, frame: GrayFrame, ms: number): Outcome;
};
type Module = {
  beginTrack: (frame: GrayFrame, t: number) => unknown;
  stepTrack: (state: unknown, frame: GrayFrame, options: { t: number }) => Record<string, unknown>;
};

type Place = { source: string; crop: number; seed: number };
/** `set` marks runs on the tiled shelves, which are reported apart from the photos. */
export type SeqJob = Place & { kind: "seq"; profile: string; cadence: number; slowdown: number; set?: "repeat" | "lookalike" };
export type SweepJob = Place & { kind: "sweep" };
export type DriftJob = Place & { kind: "drift" };
export type UnrelatedJob = Place & { kind: "unrelated" };
export type Job = SeqJob | SweepJob | DriftJob | UnrelatedJob;

export type SeqResult = {
  kind: "seq";
  job: SeqJob;
  api: Api;
  beginOk: boolean;
  anchors: number;
  eligible: number;
  correct: number;
  shown: number;
  wrong: number;
  /** The same four counts over every displayed 30 fps frame, with the worker's delay and labels held between samples. */
  frames: { eligible: number; correct: number; shown: number; wrong: number };
  errors: number[];
  over10: number;
  relocks: number;
  badRelocks: number;
  recoveryMs?: number | null;
  lostAtMs: number | null;
  beginMs: number;
  stepMs: number[];
  display: number[];
  reasons: Record<string, number>;
};
export type SweepResult = { kind: "sweep"; job: SweepJob; api: Api; cases: { name: string; accepted: boolean; error: number | null; ms: number }[] };
export type DriftResult = { kind: "drift"; job: DriftJob; api: Api; failed: number; finalAccepted: boolean; checkpoints: Record<number, number | null>; stepMs: number[] };
export type UnrelatedResult = { kind: "unrelated"; job: UnrelatedJob; api: Api; cases: { name: string; accepted: number; steps: number; error?: number | null }[] };
export type Result = SeqResult | SweepResult | DriftResult | UnrelatedResult;

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const FRAME_MS = 1000 / 30;
const LOST_AFTER = 4;
const GIVE_UP_MS = 1500;
// 1x cost of drawing the video at 480 px, reading it back and converting to gray, measured in the research.
const READBACK_MS = 3.4;
const STATIC: Optics = { exposureMs: 0, shutterMs: 0, noise: 0.008 };
const GRID = [0.15, 0.5, 0.85].flatMap((fy) => [0.15, 0.5, 0.85].map((fx) => [fx * (FRAME_W - 1), fy * (FRAME_H - 1)]));
export const DRIFT_CHECKPOINTS = [10, 50, 100, 200, 300];
const UNRELATED_STEPS = 10;

export async function loadTracker(path: string): Promise<Tracker> {
  const mod = (await import(pathToFileURL(resolve(path)).href)) as Module;
  const tracker: Tracker = {
    api: "old",
    begin(frame, ms) {
      const result = mod.beginTrack(frame, ms);
      if (result && typeof result === "object" && "ok" in result && "state" in result) {
        tracker.api = "new";
        return { state: result.state, ok: Boolean(result.ok) };
      }
      return { state: result, ok: result != null };
    },
    step(state, frame, ms) {
      const result = mod.stepTrack(state, frame, { t: ms });
      const status = typeof result.status === "string" ? result.status : null;
      const accepted = status ? status === "tracked" : Boolean(result.steady);
      return {
        state: result.state ?? state,
        accepted,
        tentative: status === "tentative",
        homography: accepted ? (result.homography as Mat3) : null,
        reason: typeof result.reason === "string" ? result.reason : null,
      };
    },
  };
  return tracker;
}

function timed<T>(run: () => T) {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

type Life = { shown: Mat3 | null; lost: boolean; step(outcome: Outcome, ms: number): void; tick(ms: number): void };

// Today's CameraScan: the last labels stay up through up to 3 failed steps, then the capture is dropped for good.
function currentApp(ok: boolean): Life {
  let unsteady = 0;
  const life: Life = {
    shown: ok ? IDENTITY : null,
    lost: !ok,
    step(outcome) {
      if (outcome.accepted) {
        life.shown = outcome.homography;
        unsteady = 0;
      } else if (++unsteady >= LOST_AFTER) {
        life.shown = null;
        life.lost = true;
      }
    },
    tick() {},
  };
  return life;
}

// The reworked CameraScan: the worker keeps its state through failed steps, the labels hide on the
// first failed step and come back with the next accepted one, and tracking gives up 1.5 s after the
// last accepted step.
function timedApp(ok: boolean): Life {
  let lastGood = 0;
  let last: Mat3 | null = ok ? IDENTITY : null;
  const life: Life = {
    shown: last,
    lost: !ok,
    step(outcome, ms) {
      if (outcome.accepted) lastGood = ms;
      last = outcome.accepted ? outcome.homography : null;
      life.tick(ms);
    },
    tick(ms) {
      if (life.lost) return;
      life.lost = ms - lastGood >= GIVE_UP_MS;
      life.shown = life.lost ? null : last;
    },
  };
  return life;
}

type Anchor = { kx: number; ky: number; box: Spine };

function anchorsFor(scene: Scene, key: Mat3): Anchor[] {
  return sceneSpines(scene).flatMap((box) => {
    const [kx, ky] = project(key, (box.x0 + box.x1) / 2, (box.y0 + box.y1) / 2);
    return inView(kx, ky) ? [{ kx, ky, box }] : [];
  });
}

type View = { truth: Mat3; toRest: Mat3; covered: boolean };

function viewAt(pose: Pose, keyInv: Mat3): View {
  const m = poseMatrix(pose);
  return { truth: multiply(m, keyInv), toRest: invert(m), covered: pose.cover > 0.5 };
}

export function gridError(estimate: Mat3, truth: Mat3) {
  const points = GRID.map(([x, y]) => {
    const [tx, ty] = project(truth, x, y);
    const [ex, ey] = project(estimate, x, y);
    return { visible: inView(tx, ty), error: Math.hypot(ex - tx, ey - ty) };
  });
  const visible = points.filter((point) => point.visible);
  return Math.max(...(visible.length ? visible : points).map((point) => point.error));
}

// A label counts as on its spine when the point it is drawn at lies inside that spine's box on the shelf.
function judge(anchors: Anchor[], view: View, shown: Mat3 | null) {
  let visible = 0;
  let visibleOn = 0;
  let drawn = 0;
  let off = 0;
  let worst: number | null = null;
  for (const anchor of anchors) {
    const [tx, ty] = project(view.truth, anchor.kx, anchor.ky);
    const isVisible = !view.covered && inView(tx, ty);
    if (isVisible) visible += 1;
    if (!shown) continue;
    const [x, y] = project(shown, anchor.kx, anchor.ky);
    if (isVisible) worst = Math.max(worst ?? 0, Math.hypot(x - tx, y - ty));
    if (!inView(x, y)) continue;
    drawn += 1;
    const [rx, ry] = project(view.toRest, x, y);
    const on = rx >= anchor.box.x0 && rx <= anchor.box.x1 && ry >= anchor.box.y0 && ry <= anchor.box.y1;
    if (!on) off += 1;
    if (isVisible && on) visibleOn += 1;
  }
  return { eligible: visible > 0, correct: visible > 0 && visibleOn === visible, shown: drawn > 0, wrong: off > 0, worst };
}

type Tally = { eligible: number; correct: number; shown: number; wrong: number };

function count(tally: Tally, verdict: ReturnType<typeof judge>) {
  if (verdict.eligible) tally.eligible += 1;
  if (verdict.correct) tally.correct += 1;
  if (verdict.shown) tally.shown += 1;
  if (verdict.shown && verdict.wrong) tally.wrong += 1;
}

function workerMs(ms: number, slowdown: number) {
  return slowdown * (ms + READBACK_MS);
}

function runSequence(job: SeqJob, tracker: Tracker, world: World): SeqResult {
  const profile = profileNamed(job.profile);
  const scene = makeScene(world.sources[job.source], world.texture, job.crop);
  const poseAt = profile.make(hash(job.seed, job.source, job.crop), scene.dir);
  const key = poseMatrix(poseAt(0));
  const keyInv = invert(key);
  const anchors = anchorsFor(scene, key);
  const noise = (n: number) => hash(job.profile, job.source, job.crop, job.seed, n);
  const keyframe = grayFrame(render(scene, poseAt, 0, profile.optics, noise(0)));
  const began = timed(() => tracker.begin(keyframe, 0));
  const life = tracker.api === "new" ? timedApp(began.value.ok) : currentApp(began.value.ok);
  const result: SeqResult = {
    kind: "seq", job, api: tracker.api, beginOk: began.value.ok, anchors: anchors.length,
    eligible: 0, correct: 0, shown: 0, wrong: 0, frames: { eligible: 0, correct: 0, shown: 0, wrong: 0 }, errors: [], over10: 0, relocks: 0, badRelocks: 0,
    lostAtMs: life.lost ? 0 : null, beginMs: began.ms, stepMs: [], display: [], reasons: {},
  };
  const eventEnd = profile.event ? profile.event[1] * 1000 : null;
  if (eventEnd !== null) result.recoveryMs = null;
  const gate = job.cadence * 0.8;
  const replies = [{ at: workerMs(began.ms, job.slowdown), shown: life.shown }];
  let state = began.value.state;
  let freeAt = replies[0].at;
  let lastSample = -Infinity;
  let failedRun = 0;
  let displayed: Mat3 | null = null;
  let held = false;
  for (let n = 1; n * FRAME_MS <= profile.seconds * 1000; n++) {
    const ms = n * FRAME_MS;
    const view = viewAt(poseAt(ms), keyInv);
    while (replies.length && replies[0].at <= ms) displayed = replies.shift()!.shown;
    life.tick(ms);
    if (life.lost) displayed = null;
    if (life.lost && result.lostAtMs === null) result.lostAtMs = ms;
    const onScreen = judge(anchors, view, displayed);
    if (onScreen.worst !== null) result.display.push(onScreen.worst);
    count(result.frames, onScreen);
    if (ms - lastSample < gate || (!life.lost && ms < freeAt)) continue;
    lastSample = ms;
    if (!life.lost) {
      const frame = grayFrame(render(scene, poseAt, ms, profile.optics, noise(n)));
      const stepped = timed(() => tracker.step(state, frame, ms));
      const outcome = stepped.value;
      state = outcome.state;
      result.stepMs.push(stepped.ms);
      freeAt = ms + workerMs(stepped.ms, job.slowdown);
      if (outcome.accepted && outcome.homography) {
        const error = gridError(outcome.homography, view.truth);
        result.errors.push(error);
        if (error > 10) result.over10 += 1;
        if (failedRun > 0) {
          result.relocks += 1;
          if (error > 10) result.badRelocks += 1;
        }
        failedRun = 0;
      } else {
        failedRun += 1;
        if (outcome.reason) result.reasons[outcome.reason] = (result.reasons[outcome.reason] ?? 0) + 1;
      }
      // The app times its labels from when the worker's reply arrives.
      life.step(outcome, freeAt);
      if (life.lost && result.lostAtMs === null) result.lostAtMs = ms;
      replies.push({ at: freeAt, shown: life.shown });
    }
    const verdict = judge(anchors, view, life.shown);
    count(result, verdict);
    // Labels already right before the event ended count as recovered at once, not one sample later.
    if (eventEnd !== null && result.recoveryMs === null) {
      if (ms >= eventEnd && verdict.correct) result.recoveryMs = held ? 0 : ms - eventEnd;
      held = verdict.correct && ms < eventEnd;
    }
  }
  return result;
}

function runSweep(job: SweepJob, tracker: Tracker, world: World): SweepResult {
  const scene = makeScene(world.sources[job.source], world.texture, job.crop);
  const keyGray = render(scene, () => REST, 0, STATIC, hash("sweep", job.source, job.crop, job.seed));
  const cases = SWEEP.map((item) => {
    const pose = { ...REST, ...item.pose };
    const began = tracker.begin(grayFrame(keyGray.slice()), 0);
    const frame = grayFrame(render(scene, () => pose, 100, STATIC, hash("sweep", job.source, job.crop, job.seed, item.name)));
    if (!began.ok) return { name: item.name, accepted: false, error: null, ms: 0 };
    const stepped = timed(() => tracker.step(began.state, frame, 100));
    const h = stepped.value.homography;
    return { name: item.name, accepted: stepped.value.accepted, error: h ? gridError(h, poseMatrix(pose)) : null, ms: stepped.ms };
  });
  return { kind: "sweep", job, api: tracker.api, cases };
}

function runDrift(job: DriftJob, tracker: Tracker, world: World): DriftResult {
  const scene = makeScene(world.sources[job.source], world.texture, job.crop);
  const path = driftPath(hash(job.seed, job.source, job.crop));
  const keyInv = invert(poseMatrix(path(0)));
  const frameAt = (i: number) => grayFrame(render(scene, () => path(i), i * 100, STATIC, hash("drift", job.source, job.crop, job.seed, i)));
  const began = tracker.begin(frameAt(0), 0);
  const result: DriftResult = { kind: "drift", job, api: tracker.api, failed: 0, finalAccepted: false, checkpoints: {}, stepMs: [] };
  let state = began.state;
  let current: Mat3 | null = began.ok ? IDENTITY : null;
  for (let i = 1; i <= DRIFT_STEPS && began.ok; i++) {
    const stepped = timed(() => tracker.step(state, frameAt(i), i * 100));
    state = stepped.value.state;
    result.stepMs.push(stepped.ms);
    if (stepped.value.accepted && stepped.value.homography) current = stepped.value.homography;
    else result.failed += 1;
    if (i === DRIFT_STEPS) result.finalAccepted = stepped.value.accepted;
    if (DRIFT_CHECKPOINTS.includes(i)) result.checkpoints[i] = current ? gridError(current, multiply(poseMatrix(path(i)), keyInv)) : null;
  }
  return result;
}

function acceptedSteps(tracker: Tracker, key: Float32Array, frames: (i: number) => Float32Array) {
  const began = tracker.begin(grayFrame(key), 0);
  if (!began.ok) return 0;
  let state = began.state;
  let accepted = 0;
  for (let i = 1; i <= UNRELATED_STEPS; i++) {
    const outcome = tracker.step(state, grayFrame(frames(i)), i * 100);
    state = outcome.state;
    if (outcome.accepted) accepted += 1;
  }
  return accepted;
}

// Content the keyframe never saw must never be reported as tracked.
function runUnrelated(job: UnrelatedJob, tracker: Tracker, world: World): UnrelatedResult {
  const scene = makeScene(world.sources[job.source], world.texture, job.crop);
  const otherName = Object.keys(world.sources).find((name) => name !== job.source && !name.endsWith("-tiled"))!;
  const other = makeScene(world.sources[otherName], world.texture, job.crop);
  const seed = (...parts: (string | number)[]) => hash("unrelated", job.source, job.crop, job.seed, ...parts);
  const golden = () => render(scene, () => REST, 0, STATIC, seed("key"));
  const cases: UnrelatedResult["cases"] = [
    { name: "noise", key: golden(), frames: (i: number) => noiseFrame(seed("noise", i)) },
    { name: "room", key: golden(), frames: (i: number) => render(scene, () => ({ ...REST, tx: 5000 + 2 * i, ty: i }), i * 100, STATIC, seed("room", i)) },
    { name: "other-shelf", key: golden(), frames: (i: number) => render(other, () => ({ ...REST, tx: 2 * i }), i * 100, STATIC, seed("other", i)) },
    { name: "noise-to-noise", key: noiseFrame(seed("noise-key")), frames: (i: number) => noiseFrame(seed("noise-next", i)) },
  ].map((item) => ({ name: item.name, accepted: acceptedSteps(tracker, item.key, item.frames), steps: UNRELATED_STEPS }));
  const noise = noiseFrame(seed("shifted"));
  const began = tracker.begin(grayFrame(noise), 0);
  const shifted = began.ok ? tracker.step(began.state, grayFrame(shiftFrame(noise, 6, 4, seed("fill"))), 100) : null;
  const shift: Mat3 = [1, 0, 6, 0, 1, 4, 0, 0, 1];
  cases.push({ name: "shifted-noise", accepted: shifted?.accepted ? 1 : 0, steps: 1, error: shifted?.homography ? gridError(shifted.homography, shift) : null });
  return { kind: "unrelated", job, api: tracker.api, cases };
}

export function runJob(job: Job, tracker: Tracker, world: World): Result {
  if (job.kind === "seq") return runSequence(job, tracker, world);
  if (job.kind === "sweep") return runSweep(job, tracker, world);
  if (job.kind === "drift") return runDrift(job, tracker, world);
  return runUnrelated(job, tracker, world);
}
