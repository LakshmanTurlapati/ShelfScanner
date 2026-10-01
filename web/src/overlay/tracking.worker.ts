import { beginTrack, grayFromRGBA, IDENTITY, stepTrack, type Mat3, type TrackState, type Velocity } from "./track";

type FrameMessage = {
  type: "begin" | "step";
  captureId: string;
  t: number;
  width: number;
  height: number;
  rgba: ArrayBuffer;
};
type EndMessage = { type: "end"; captureId: string };
type ResetMessage = { type: "reset" };

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
};

let state: TrackState | null = null;
let activeId: string | null = null;

function track(message: FrameMessage) {
  const frame = {
    gray: grayFromRGBA(new Uint8ClampedArray(message.rgba), message.width, message.height),
    width: message.width,
    height: message.height,
  };
  if (message.type === "begin") {
    activeId = message.captureId;
    const begun = beginTrack(frame, message.t);
    state = begun.state;
    const reason = begun.ok ? null : "few-corners";
    return { homography: begun.ok ? IDENTITY : null, ok: begun.ok, hard: !begun.ok, velocity: null, inliers: begun.points, reason };
  }
  if (message.captureId !== activeId || !state) return { homography: null, ok: false, hard: false, velocity: null, inliers: 0, reason: "inactive" };
  const result = stepTrack(state, frame, { t: message.t });
  state = result.state;
  return { homography: result.homography, ok: result.steady, hard: result.hard, velocity: result.velocity, inliers: result.inliers, reason: result.reason };
}

self.onmessage = (event: MessageEvent<FrameMessage | EndMessage | ResetMessage>) => {
  const message = event.data;
  if (message.type === "reset" || (message.type === "end" && message.captureId === activeId)) {
    state = null;
    activeId = null;
    return;
  }
  if (message.type === "end") return;
  const started = performance.now();
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
