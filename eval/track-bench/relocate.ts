// Relocation bench: can the app find an earlier read again when the walk comes back to it?
//
//   npm run eval:relocate
//
// Keyframes are rendered along each golden shelf photo a part-frame apart, as a walk would read
// them. Views are then rendered near each keyframe at a different distance, angle, exposure and
// motion blur, plus views of other shelves and of the room. Every view is relocated against all
// the keyframes, farthest first, the way the app would try them with no idea where it is.
// A found pose is correct within 3 px over a 3x3 grid of the view; anything else found is wrong.
// Bars: no wrong pose at all, and at least 90% of everyday views found.
import { describe, keyEntry, relocate, type KeyEntry } from "../../web/src/overlay/relocate.ts";
import type { Mat3 as TrackMat3 } from "../../web/src/overlay/track.ts";
import { decodeGolden, FRAME_H, FRAME_W, invert, makeScene, makeTexture, multiply, poseMatrix, project, REST, render, type Optics, type Pose, type Scene } from "./scene.ts";

type Group = "everyday" | "stress" | "unrelated";
type Change = { name: string; group: Group; dx: number; zoom?: number; roll?: number; gain?: number; speed?: number; optics?: Partial<Optics> };
type Outcome = { group: Group; name: string; result: "correct" | "wrong" | "missed" | "refused"; ms: number; error: number | null };

const BASE: Optics = { exposureMs: 20, shutterMs: 0, noise: 0.008 };
const HARSH: Partial<Optics> = { exposureMs: 33, shutterMs: 25, noise: 0.016 };
const KEY_STEP = 380;
const MAX_KEYS = 6;
const CORRECT_PX = 3;

const CHANGES: Change[] = [
  { name: "same spot", group: "everyday", dx: 0 },
  { name: "a little left", group: "everyday", dx: -90 },
  { name: "a little right", group: "everyday", dx: 110 },
  { name: "closer", group: "everyday", dx: 40, zoom: 1.08 },
  { name: "farther", group: "everyday", dx: -40, zoom: 0.93 },
  { name: "tilted", group: "everyday", dx: 60, roll: 2.5 },
  { name: "darker", group: "everyday", dx: -30, gain: 0.8 },
  { name: "brighter", group: "everyday", dx: 30, gain: 1.2 },
  { name: "walking past", group: "everyday", dx: 50, speed: 150 },
  { name: "much closer", group: "stress", dx: 20, zoom: 1.18 },
  { name: "much farther", group: "stress", dx: -20, zoom: 0.86 },
  { name: "tilted more", group: "stress", dx: 40, roll: 5 },
  { name: "half overlap", group: "stress", dx: 230 },
  { name: "fast and blurred", group: "stress", dx: 70, speed: 400, optics: HARSH },
];

function poseAt(base: Pose, speed: number) {
  // A camera panning at `speed` px/s during the exposure; at ms 0 it is exactly at `base`.
  return (ms: number): Pose => ({ ...base, tx: base.tx - (speed * ms) / 1000 });
}

function frame(scene: Scene, pose: Pose, optics: Optics, speed: number, seed: number) {
  return { gray: render(scene, poseAt(pose, speed), 0, optics, seed), width: FRAME_W, height: FRAME_H };
}

// Keyframe pixels to view pixels, from the poses: rest frame -> keyframe, rest frame -> view.
function truth(key: Pose, view: Pose) {
  return multiply(poseMatrix(view), invert(poseMatrix(key)));
}

function gridError(estimate: TrackMat3, actual: number[]) {
  const back = invert(actual);
  let worst = 0;
  for (const gx of [0.15, 0.5, 0.85]) {
    for (const gy of [0.15, 0.5, 0.85]) {
      const [kx, ky] = project(back, gx * FRAME_W, gy * FRAME_H);
      const [x, y] = project(estimate, kx, ky);
      worst = Math.max(worst, Math.hypot(x - gx * FRAME_W, y - gy * FRAME_H));
    }
  }
  return worst;
}

function percentile(values: number[], p: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const texture = makeTexture();
const sources = ["crai-spines-17", "old-books-bookshelf"].map(decodeGolden);
const outcomes: Outcome[] = [];
let seed = 1;

for (const source of sources) {
  const scene = makeScene(source, texture, 0);
  // Walking right moves the shelf left in the frame: tx goes negative.
  const span = source.width / 2 - FRAME_W;
  const keys = Array.from({ length: Math.min(MAX_KEYS, Math.floor(span / KEY_STEP) + 1) }, (_, i) => ({ ...REST, tx: -i * KEY_STEP }));
  const library = new Map<string, KeyEntry>();
  keys.forEach((pose, i) => {
    const gray = frame(scene, pose, BASE, 0, seed++);
    library.set(`${source.name}:${i}`, keyEntry(gray, describe(gray)));
  });
  const ids = [...library.keys()];
  keys.forEach((key, index) => {
    // Farthest keyframes first: the right one is tried last, after every chance of a false match.
    const order = [...ids].sort((a, b) => Math.abs(Number(b.split(":")[1]) - index) - Math.abs(Number(a.split(":")[1]) - index));
    for (const change of CHANGES) {
      const pose: Pose = { ...key, tx: key.tx - change.dx, zoom: change.zoom ?? 1, roll: change.roll ?? 0, gain: change.gain ?? 1 };
      const view = frame(scene, pose, { ...BASE, ...change.optics }, change.speed ?? 0, seed++);
      const started = performance.now();
      const found = relocate(library, view, order, 1000);
      const ms = performance.now() - started;
      if (!found) {
        outcomes.push({ group: change.group, name: change.name, result: "missed", ms, error: null });
        continue;
      }
      const keyIndex = Number(found.captureId.split(":")[1]);
      const error = gridError(found.h, truth(keys[keyIndex], pose));
      outcomes.push({ group: change.group, name: change.name, result: error <= CORRECT_PX ? "correct" : "wrong", ms, error });
    }
  });
  // Views of the other shelf and of the room around it must never be found here.
  const other = makeScene(sources.find((item) => item !== source)!, texture, 0.5);
  for (const [name, scenery, pose] of [
    ["other shelf", other, REST],
    ["other shelf, moved", other, { ...REST, tx: -200, zoom: 1.05 }],
    ["the room", scene, { ...REST, tx: 3000, ty: 1400 }],
    ["the room, moved", scene, { ...REST, tx: -3000, ty: -1600, roll: 3 }],
  ] as const) {
    const view = frame(scenery, pose, BASE, 0, seed++);
    const started = performance.now();
    const found = relocate(library, view, ids, 1000);
    outcomes.push({ group: "unrelated", name, result: found ? "wrong" : "refused", ms: performance.now() - started, error: null });
  }
}

const rows = new Map<string, Outcome[]>();
for (const outcome of outcomes) rows.set(`${outcome.group}|${outcome.name}`, [...(rows.get(`${outcome.group}|${outcome.name}`) ?? []), outcome]);
console.log("case                  group      found  wrong  missed  max err px  ms p50  ms p90");
for (const [key, items] of rows) {
  const [group, name] = key.split("|");
  const count = (result: Outcome["result"]) => items.filter((item) => item.result === result).length;
  const found = group === "unrelated" ? `${count("refused")}/${items.length} refused` : `${count("correct")}/${items.length}`;
  const errors = items.flatMap((item) => (item.error === null ? [] : [item.error]));
  console.log(
    `${name.padEnd(22)}${group.padEnd(11)}${found.padEnd(7)}${String(count("wrong")).padStart(5)}${String(count("missed")).padStart(8)}` +
    `${(errors.length ? Math.max(...errors).toFixed(2) : "").padStart(12)}${percentile(items.map((item) => item.ms), 50).toFixed(0).padStart(8)}${percentile(items.map((item) => item.ms), 90).toFixed(0).padStart(8)}`,
  );
}

const everyday = outcomes.filter((item) => item.group === "everyday");
const correctShare = everyday.filter((item) => item.result === "correct").length / Math.max(1, everyday.length);
const wrong = outcomes.filter((item) => item.result === "wrong").length;
console.log(`\neveryday found ${(correctShare * 100).toFixed(1)}% (bar 90%), wrong poses ${wrong} (bar 0), ms p90 ${percentile(outcomes.map((item) => item.ms), 90).toFixed(0)}`);
if (wrong > 0 || correctShare < 0.9) {
  console.log("relocation bench: a bar was missed");
  process.exitCode = 1;
}
