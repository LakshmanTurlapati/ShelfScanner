import { FOCAL, hash, mulberry, REST, type Optics, type Pose } from "./scene.ts";

export type Group = "everyday" | "stress" | "event";
type Channel = (s: number) => number;
type Channels = Partial<Record<keyof Pose, Channel>>;
type Shape = { channels: Channels; seconds: number; event?: [number, number] };
export type Profile = {
  name: string;
  group: Group;
  optics: Optics;
  seconds: number;
  event?: [number, number];
  make: (seed: number, dir: number) => (ms: number) => Pose;
};
type Move = { at: number; seconds: number; by: number };

const OPTICS: Optics = { exposureMs: 20, shutterMs: 0, noise: 0.008 };
const HARSH: Partial<Optics> = { exposureMs: 33, shutterMs: 25, noise: 0.016 };
const PX_PER_DEG = (FOCAL * Math.PI) / 180;
const RAMP = 0.15;
const STILL = 0.6;

// Trapezoid velocity: accelerate over the first 15%, cruise, decelerate over the last 15%.
function ease(u: number) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const top = 1 / (1 - RAMP);
  if (u < RAMP) return (0.5 * top * u * u) / RAMP;
  if (u > 1 - RAMP) return 1 - (0.5 * top * (1 - u) ** 2) / RAMP;
  return top * (u - RAMP / 2);
}

function glide(at: number, by: number, rate: number): Move {
  return { at, seconds: Math.abs(by) / (rate * (1 - RAMP)), by };
}

function after(move: Move, dwell = 0) {
  return move.at + move.seconds + dwell;
}

function moves(...list: Move[]): Channel {
  return (s) => list.reduce((sum, move) => sum + move.by * ease((s - move.at) / move.seconds), 0);
}

function exp(channel: Channel): Channel {
  return (s) => Math.exp(channel(s));
}

function degreesFor(px: number) {
  return (Math.atan(px / FOCAL) * 180) / Math.PI;
}

// Sum of five sines between 0.35 and 4.1 Hz per axis, scaled to the requested RMS angular speed.
function tremor(rate: number, seed: number) {
  const random = mulberry(seed);
  const axis = (rms: number): Channel => {
    const waves = Array.from({ length: 5 }, () => ({ f: 0.35 * (4.1 / 0.35) ** random(), phase: 2 * Math.PI * random(), weight: 0.5 + random() / 2 }));
    const scale = rms / Math.sqrt(waves.reduce((sum, wave) => sum + wave.weight ** 2 / 2, 0));
    return (s) => waves.reduce((sum, wave) => sum + ((scale * wave.weight) / (2 * Math.PI * wave.f)) * Math.sin(2 * Math.PI * wave.f * s + wave.phase), 0);
  };
  return { yaw: axis(rate / Math.SQRT2), pitch: axis(rate / Math.SQRT2), roll: axis(rate / 4) };
}

function profile(name: string, group: Group, hand: number, build: (dir: number, seed: number) => Shape, optics: Partial<Optics> = {}): Profile {
  const shape = build(1, 1);
  return {
    name,
    group,
    optics: { ...OPTICS, ...optics },
    seconds: shape.seconds,
    event: shape.event,
    make(seed, dir) {
      const { channels } = build(dir, seed);
      const shake = tremor(hand, hash(name, seed));
      const value = (key: keyof Pose, s: number, fallback: number) => channels[key]?.(s) ?? fallback;
      return (ms) => {
        const s = ms / 1000;
        return {
          yaw: shake.yaw(s) + value("yaw", s, 0),
          pitch: shake.pitch(s) + value("pitch", s, 0),
          roll: shake.roll(s) + value("roll", s, 0),
          zoom: value("zoom", s, 1),
          tx: value("tx", s, 0),
          ty: value("ty", s, 0),
          gain: value("gain", s, 1),
          offset: value("offset", s, 0),
          cover: value("cover", s, 0),
        };
      };
    },
  };
}

function held(name: string, rate: number, group: Group = "everyday") {
  return profile(name, group, rate, () => ({ channels: {}, seconds: 8 }));
}

function pan(name: string, degrees: number, rate: number, group: Group = "everyday", optics: Partial<Optics> = {}) {
  return profile(name, group, 1, (dir) => {
    const out = glide(STILL, dir * degrees, rate);
    const back = glide(after(out, 0.5), -dir * degrees, rate);
    return { channels: { yaw: moves(out, back) }, seconds: after(back, 0.6) };
  }, optics);
}

// A sideways move of 1.25 frame widths (about 48° of travel) at the speed of an 8°/s pan, so every keyframe point leaves the view.
function longPan() {
  return profile("longpan", "everyday", 1, (dir) => {
    const out = glide(STILL, -dir * 600, 8 * PX_PER_DEG);
    const back = glide(after(out, 0.5), dir * 600, 8 * PX_PER_DEG);
    return { channels: { tx: moves(out, back) }, seconds: after(back, 0.6) };
  });
}

function zoom() {
  return profile("zoom", "everyday", 1, () => {
    const out = glide(STILL, Math.log(1.5), Math.log(1.2));
    const back = glide(after(out, 0.5), -Math.log(1.5), Math.log(1.2));
    return { channels: { zoom: exp(moves(out, back)) }, seconds: after(back, 0.6) };
  });
}

function roll() {
  return profile("roll", "everyday", 1, () => {
    const out = glide(STILL, 25, 25);
    const back = glide(after(out, 0.5), -25, 25);
    return { channels: { roll: moves(out, back) }, seconds: after(back, 0.6) };
  });
}

function exposure(name: string, low: number, high: number) {
  return profile(name, "everyday", 1, () => ({
    channels: { gain: (s) => 1 + moves({ at: 1, seconds: 0.1, by: low - 1 }, { at: 2.5, seconds: 0.1, by: high - low }, { at: 4, seconds: 0.1, by: 1 - high })(s) },
    seconds: 5,
  }));
}

// Walking along the shelf: sideways travel with step bob, slow lean-in, sway and auto-exposure drift.
function walk(name: string, group: Group, hand: number, optics: Partial<Optics> = {}) {
  return profile(name, group, hand, (dir) => {
    const out = glide(STILL, -dir * 450, 150);
    const back = glide(after(out, 0.6), dir * 450, 150);
    return {
      channels: {
        tx: moves(out, back),
        ty: (s) => 6 * Math.sin(2 * Math.PI * 1.8 * s),
        roll: (s) => 1.5 * Math.sin(2 * Math.PI * 0.9 * s),
        zoom: exp(moves({ ...out, by: Math.log(1.1) }, { ...back, by: -Math.log(1.1) })),
        gain: (s) => 1 + moves({ at: 1.5, seconds: 1, by: -0.15 }, { at: 4, seconds: 1, by: 0.25 }, { at: 6.5, seconds: 1, by: -0.1 })(s),
      },
      seconds: after(back, 0.6),
    };
  }, optics);
}

function shake() {
  return profile("shake", "event", 1, (dir, seed) => {
    const random = mulberry(hash("shake", seed));
    const phases = [random(), random()].map((value) => value * 2 * Math.PI);
    const start = 1;
    const length = 0.6;
    const window = (s: number) => (s < start || s > start + length ? 0 : Math.sin((Math.PI * (s - start)) / length));
    const drift = moves({ at: start, seconds: length, by: 2 * dir });
    return {
      channels: {
        yaw: (s) => drift(s) + 2.5 * Math.sin(2 * Math.PI * 4.5 * (s - start) + phases[0]) * window(s),
        pitch: (s) => 1.5 * Math.sin(2 * Math.PI * 5 * (s - start) + phases[1]) * window(s),
      },
      seconds: 4,
      event: [start, start + length],
    };
  });
}

function whip(name: string, offset: { px: number; roll: number; zoom: number }) {
  return profile(name, "event", 1, (dir) => {
    const away = degreesFor(400);
    const out = glide(0.8, dir * away, 120);
    const back = glide(after(out, 0.3), -dir * (away - degreesFor(offset.px)), 120);
    return {
      channels: {
        yaw: moves(out, back),
        roll: moves({ ...back, by: offset.roll }),
        zoom: exp(moves({ ...back, by: Math.log(offset.zoom) })),
      },
      seconds: after(back, 2.5),
      event: [0.8, after(back)],
    };
  });
}

// The pose moves a little while the lens is covered, so the view comes back slightly off.
function cover(name: string, seconds: number) {
  return profile(name, "event", 1, (dir) => {
    const start = 1;
    const end = start + seconds;
    const shift = (by: number) => moves({ at: start + 0.1, seconds: Math.min(0.5, seconds - 0.2), by });
    return {
      channels: { cover: (s) => (s >= start && s < end ? 1 : 0), yaw: shift(2 * dir), pitch: shift(-1), roll: shift(3) },
      seconds: end + 2.5,
      event: [start, end],
    };
  });
}

function drop() {
  return profile("drop", "event", 1, (dir) => {
    const down = { at: 1, seconds: 0.35, by: -40 };
    const up = { at: after(down, 1.5), seconds: 0.35, by: 40 };
    return { channels: { pitch: moves(down, up), yaw: moves({ ...up, by: dir }) }, seconds: after(up, 2.5), event: [1, after(up)] };
  });
}

function away() {
  return profile("away", "event", 1, (dir) => {
    const out = { at: 1, seconds: 0.6, by: 45 * dir };
    const back = { at: after(out, 1.5), seconds: 0.6, by: -45 * dir };
    return { channels: { yaw: moves(out, back), zoom: exp(moves({ ...back, by: Math.log(1.33) })) }, seconds: after(back, 2.5), event: [1, after(back)] };
  });
}

export const PROFILES: Profile[] = [
  held("hold", 1.5),
  held("hand4", 4),
  held("hand8", 8),
  pan("pan10", 15, 10),
  pan("pan30", 25, 30),
  pan("blurpan", 20, 20, "everyday", { exposureMs: 33 }),
  longPan(),
  zoom(),
  roll(),
  exposure("exposure", 0.7, 1.35),
  exposure("exposure2", 0.55, 1.25),
  walk("walk", "everyday", 2),
  held("hand15", 15, "stress"),
  pan("pan60", 30, 60, "stress"),
  walk("harshwalk", "stress", 3, HARSH),
  shake(),
  whip("whip", { px: 0, roll: 0, zoom: 1 }),
  whip("whipoff", { px: 70, roll: 3, zoom: 1.05 }),
  cover("cover0.7", 0.7),
  cover("cover1.5", 1.5),
  drop(),
  away(),
];

export const REPEAT_PROFILES = ["pan30", "shake", "whip", "cover0.7"];
export const LOOKALIKE_PROFILES = ["pan30", "pan60", "shake"];

export function profileNamed(name: string) {
  const found = PROFILES.find((item) => item.name === name);
  if (!found) throw new Error(`Unknown profile ${name}`);
  return found;
}

export type SweepCase = { name: string; pose: Partial<Pose>; bar: boolean };

export const SWEEP: SweepCase[] = [
  ...[2, 4, 8, 16, 24, 32, 40, 48].map((px) => ({ name: `pan${px}`, pose: { tx: px }, bar: px === 32 })),
  { name: "diag16", pose: { tx: 16, ty: 16 }, bar: false },
  { name: "yaw3", pose: { yaw: 3 }, bar: false },
  ...[1, 2, 3, 5, 8].map((deg) => ({ name: `roll${deg}`, pose: { roll: deg }, bar: deg === 5 })),
  ...[1.02, 1.04, 1.08, 1.15].map((scale) => ({ name: `zoom${scale}`, pose: { zoom: scale }, bar: scale === 1.08 })),
  ...[0.6, 0.8, 1.2, 1.4].map((gain) => ({ name: `gain${gain}`, pose: { gain }, bar: gain === 0.6 || gain === 1.4 })),
  { name: "offset-0.1", pose: { offset: -0.1 }, bar: true },
  { name: "offset+0.1", pose: { offset: 0.1 }, bar: true },
  { name: "roll8+zoom1.1", pose: { roll: 8, zoom: 1.1 }, bar: false },
  { name: "pan16+gain0.7", pose: { tx: 16, gain: 0.7 }, bar: false },
];

export const DRIFT_STEPS = 300;

// A hand-held random walk of about 0.5 px per step that ends exactly where it started.
export function driftPath(seed: number) {
  const random = mulberry(hash("drift", seed));
  const gauss = () => (random() + random() + random() + random() - 2) * Math.sqrt(3);
  const step = 0.5 / PX_PER_DEG / Math.SQRT2;
  const walk = [[0, 0, 0]];
  for (let i = 1; i <= DRIFT_STEPS; i++) {
    const [yaw, pitch, roll] = walk[i - 1];
    walk.push([yaw + gauss() * step, pitch + gauss() * step, roll + gauss() * 0.04]);
  }
  const last = walk[DRIFT_STEPS];
  return (i: number): Pose => {
    const k = i / DRIFT_STEPS;
    return { ...REST, yaw: walk[i][0] - last[0] * k, pitch: walk[i][1] - last[1] * k, roll: walk[i][2] - last[2] * k };
  };
}
