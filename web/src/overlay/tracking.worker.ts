import { describe, keyEntry, quantize, relocate, type KeyEntry } from "./relocate";
import { beginTrack, grayFromRGBA, IDENTITY, stepTrack, type Mat3, type TrackState, type Velocity } from "./track";

type FrameMessage = {
  type: "begin" | "step";
  captureId: string;
  t: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
  /** begin: link the new keyframe to the read being tracked by stepping onto it. */
  link?: boolean;
  /** begin: earlier reads to relocate the new keyframe on when it cannot be linked by a step. */
  candidates?: string[];
  /** step: earlier reads to look for in this frame while tracking holds. */
  probe?: string[];
};
type RelocateMessage = { type: "relocate"; seq: number; t: number; width: number; height: number; rgba: ArrayBuffer; candidates: string[] };
type ForgetMessage = { type: "forget"; captureIds?: string[] };
type EndMessage = { type: "end"; captureId: string };
type ResetMessage = { type: "reset" };

/** `h` maps the earlier read's keyframe (`from`) into this frame. */
export type Link = { from: string; h: Mat3 };

export type TrackingReply = {
  type: "begin" | "step";
  captureId: string;
  t: number;
  width: number;
  height: number;
  homography: Mat3 | null;
  ok: boolean;
  status: "tracked" | "unsteady";
  hard: boolean;
  velocity: Velocity | null;
  inliers: number;
  reason: string | null;
  ms: number;
  link: Link | null;
  probe: Link | null;
};

export type RelocatedReply = {
  type: "relocated";
  seq: number;
  captureId: string | null;
  homography: Mat3 | null;
  width: number;
  height: number;
  t: number;
  ms: number;
};

export type WorkerReply = TrackingReply | RelocatedReply;

let state: TrackState | null = null;
let activeId: string | null = null;
// Keyframes of this walk's reads, kept as 8-bit grey. The page decides which to forget.
const library = new Map<string, KeyEntry>();

function frameOf(message: { rgba: ArrayBuffer; width: number; height: number }) {
  return quantize({
    gray: grayFromRGBA(new Uint8ClampedArray(message.rgba), message.width, message.height),
    width: message.width,
    height: message.height,
  });
}

function track(message: FrameMessage) {
  const frame = frameOf(message);
  if (message.type === "begin") {
    let link: Link | null = null;
    // The new keyframe is the current view, so one more step of the old track says where it sits.
    if (message.link && state && activeId) {
      const stepped = stepTrack(state, frame, { t: message.t });
      if (stepped.homography) link = { from: activeId, h: stepped.homography };
    }
    const begun = beginTrack(frame, message.t);
    if (begun.ok) {
      const entry = keyEntry(frame, describe(frame));
      if (!link && message.candidates?.length) {
        const found = relocate(library, frame, message.candidates.filter((id) => id !== message.captureId), message.t, entry.description);
        if (found) link = { from: found.captureId, h: found.h };
      }
      library.set(message.captureId, entry);
    }
    activeId = message.captureId;
    state = begun.state;
    const reason = begun.ok ? null : "few-corners";
    return { homography: begun.ok ? IDENTITY : null, ok: begun.ok, hard: !begun.ok, velocity: null, inliers: begun.points, reason, link, probe: null };
  }
  if (message.captureId !== activeId || !state) return { homography: null, ok: false, hard: false, velocity: null, inliers: 0, reason: "inactive", link: null, probe: null };
  const result = stepTrack(state, frame, { t: message.t });
  state = result.state;
  let probe: Link | null = null;
  const others = message.probe?.filter((id) => id !== activeId) ?? [];
  if (result.homography && others.length) {
    const found = relocate(library, frame, others, message.t);
    if (found) probe = { from: found.captureId, h: found.h };
  }
  return { homography: result.homography, ok: result.steady, hard: result.hard, velocity: result.velocity, inliers: result.inliers, reason: result.reason, link: null, probe };
}

self.onmessage = (event: MessageEvent<FrameMessage | RelocateMessage | ForgetMessage | EndMessage | ResetMessage>) => {
  const message = event.data;
  if (message.type === "reset" || (message.type === "end" && message.captureId === activeId)) {
    state = null;
    activeId = null;
    return;
  }
  if (message.type === "end") return;
  if (message.type === "forget") {
    if (!message.captureIds) library.clear();
    else for (const id of message.captureIds) library.delete(id);
    return;
  }
  const started = performance.now();
  if (message.type === "relocate") {
    const found = relocate(library, frameOf(message), message.candidates, message.t);
    // A view found again resumes that read's track, as if it had never been lost.
    if (found) {
      state = found.state;
      activeId = found.captureId;
    }
    const reply: RelocatedReply = {
      type: "relocated",
      seq: message.seq,
      captureId: found?.captureId ?? null,
      homography: found?.h ?? null,
      width: message.width,
      height: message.height,
      t: message.t,
      ms: performance.now() - started,
    };
    self.postMessage(reply);
    return;
  }
  const result = track(message);
  const reply: TrackingReply = {
    type: message.type,
    captureId: message.captureId,
    t: message.t,
    width: message.width,
    height: message.height,
    ...result,
    status: result.ok ? "tracked" : "unsteady",
    ms: performance.now() - started,
  };
  self.postMessage(reply);
};
