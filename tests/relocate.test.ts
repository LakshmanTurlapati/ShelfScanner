import { describe, expect, it } from "vitest";
import { describe as describeFrame, keyEntry, matchDescriptions, quantize, relocate, type KeyEntry } from "../web/src/overlay/relocate.ts";
import type { GrayFrame } from "../web/src/overlay/track.ts";
import type { RelocatedReply, TrackingReply } from "../web/src/overlay/tracking.worker.ts";
import { HEIGHT, render, repeated, shelf, truth, viewError, WIDTH, type Pose, type Texture } from "./fixtures/shelf-scene.ts";

// Three reads a frame apart along a shelf five frames wide.
function walk(seed: number) {
  const texture = shelf(WIDTH * 5, HEIGHT + 200, seed);
  const y = (HEIGHT + 200) / 2;
  const keys: Record<string, Pose> = {
    k0: { x: WIDTH * 0.75, y },
    k1: { x: WIDTH * 1.75, y },
    k2: { x: WIDTH * 2.75, y },
  };
  const library = new Map<string, KeyEntry>(Object.entries(keys).map(([id, pose]) => [id, keyEntry(quantize(render(texture, pose)))]));
  return { texture, keys, library };
}

describe("relocation", () => {
  it("finds the earlier read a walk came back to, from a different distance and angle", { timeout: 60_000 }, () => {
    const { texture, keys, library } = walk(31);
    for (const change of [{ dx: 60, zoom: 1.08, angle: 2 }, { dx: -70, zoom: 0.92, angle: -3 }, { dx: 30, zoom: 1, angle: 0 }]) {
      const pose = { ...keys.k1, x: keys.k1.x + change.dx, zoom: change.zoom, angle: change.angle };
      const found = relocate(library, quantize(render(texture, pose, { seed: 5 })), ["k0", "k1", "k2"], 1000);
      expect(found?.captureId).toBe("k1");
      expect(viewError(found!.h, truth(keys.k1, pose))).toBeLessThan(2);
      // The resumed track starts without a velocity, so its next prediction is no motion.
      expect(found!.state.velocity).toBeNull();
    }
  });

  it("refuses a shelf it has never seen", { timeout: 60_000 }, () => {
    const { keys, library } = walk(32);
    const other = shelf(WIDTH * 5, HEIGHT + 200, 77);
    expect(relocate(library, quantize(render(other, keys.k1)), ["k0", "k1", "k2"], 1000)).toBeNull();
  });

  it("refuses rather than guesses on a shelf of identical spines", { timeout: 60_000 }, () => {
    const period = 52;
    const texture: Texture = repeated(shelf(WIDTH * 4, HEIGHT + 200, 33), period);
    const key = { x: WIDTH * 1.5, y: (HEIGHT + 200) / 2 };
    const library = new Map([["k", keyEntry(quantize(render(texture, key)))]]);
    let wrong = 0;
    for (const dx of [period * 2 + 3, period * 3 - 4, period * 5]) {
      const pose = { ...key, x: key.x + dx };
      const found = relocate(library, quantize(render(texture, pose)), ["k"], 1000);
      if (found && viewError(found.h, truth(key, pose)) > 3) wrong++;
    }
    expect(wrong).toBe(0);
  });

  it("matches corners one to one and keeps only clear matches", () => {
    const texture = shelf(WIDTH * 2, HEIGHT + 200, 34);
    const key = { x: WIDTH, y: (HEIGHT + 200) / 2 };
    const a = describeFrame(quantize(render(texture, key)));
    const b = describeFrame(quantize(render(texture, { ...key, x: key.x + 40 })));
    const { src, dst } = matchDescriptions(a, b);
    expect(src.length).toBeGreaterThan(40);
    expect(new Set(dst.map(([x, y]) => `${x},${y}`)).size).toBe(dst.length);
    // Most matches agree on the 40 px shift.
    const agree = src.filter(([x, y], i) => Math.hypot(dst[i][0] - (x - 40), dst[i][1] - y) < 3).length;
    expect(agree / src.length).toBeGreaterThan(0.7);
  });
});

function rgba(frame: GrayFrame) {
  const out = new Uint8ClampedArray(frame.width * frame.height * 4);
  for (let i = 0; i < frame.gray.length; i++) {
    const value = Math.round(frame.gray[i] * 255);
    out[i * 4] = value;
    out[i * 4 + 1] = value;
    out[i * 4 + 2] = value;
    out[i * 4 + 3] = 255;
  }
  return out.buffer;
}

describe("tracking worker", () => {
  it("links a new read to the tracked one, resumes an earlier read, and finds one while tracking", { timeout: 120_000 }, async () => {
    const posted: (TrackingReply | RelocatedReply)[] = [];
    const scope = globalThis as unknown as { self: { postMessage: (message: unknown) => void; onmessage?: (event: { data: unknown }) => void } };
    scope.self = { postMessage: (message) => posted.push(message as TrackingReply | RelocatedReply) };
    await import("../web/src/overlay/tracking.worker.ts");
    const send = (data: Record<string, unknown>) => scope.self.onmessage!({ data });
    const last = () => posted[posted.length - 1];
    const texture = shelf(WIDTH * 5, HEIGHT + 200, 41);
    const y = (HEIGHT + 200) / 2;
    const frame = (x: number) => rgba(render(texture, { x, y }));
    const size = { width: WIDTH, height: HEIGHT };

    send({ type: "begin", captureId: "a", t: 0, ...size, rgba: frame(WIDTH), link: false, candidates: [] });
    expect((last() as TrackingReply).ok).toBe(true);
    // Walk right in small steps, then read again: the new keyframe links to "a" by one more step.
    for (let step = 1; step <= 6; step++) send({ type: "step", captureId: "a", t: step * 80, ...size, rgba: frame(WIDTH + step * 30) });
    expect((last() as TrackingReply).homography).not.toBeNull();
    send({ type: "begin", captureId: "b", t: 560, ...size, rgba: frame(WIDTH + 200), link: true, candidates: ["a"] });
    const begun = last() as TrackingReply;
    expect(begun.link?.from).toBe("a");
    expect(viewError(begun.link!.h, truth({ x: WIDTH, y }, { x: WIDTH + 200, y }))).toBeLessThan(2);

    // Tracking lost far away, then back at "a": relocation resumes "a".
    send({ type: "end", captureId: "b" });
    send({ type: "relocate", seq: 3, t: 2000, ...size, rgba: frame(WIDTH + 25), candidates: ["b", "a"] });
    const relocated = last() as RelocatedReply;
    expect(relocated.type).toBe("relocated");
    expect(relocated.seq).toBe(3);
    expect(["a", "b"]).toContain(relocated.captureId);
    // Tracking resumes on whichever read it found.
    send({ type: "step", captureId: relocated.captureId, t: 2080, ...size, rgba: frame(WIDTH + 30) });
    expect((last() as TrackingReply).homography).not.toBeNull();

    // A read made with tracking lost is found in the view of another while tracking holds.
    send({ type: "begin", captureId: "c", t: 3000, ...size, rgba: frame(WIDTH * 3), link: false, candidates: [] });
    send({ type: "step", captureId: "c", t: 3080, ...size, rgba: frame(WIDTH * 3 - 10), probe: ["a"] });
    expect((last() as TrackingReply).probe).toBeNull();
    send({ type: "forget", captureIds: ["a"] });
    send({ type: "relocate", seq: 4, t: 4000, ...size, rgba: frame(WIDTH), candidates: ["a"] });
    expect((last() as RelocatedReply).captureId).toBeNull();

    // A read begun apart from b, whose view overlaps b's: the probe finds b alongside the step.
    send({ type: "begin", captureId: "d", t: 5000, ...size, rgba: frame(WIDTH + 120), link: false, candidates: [] });
    send({ type: "step", captureId: "d", t: 5080, ...size, rgba: frame(WIDTH + 130), probe: ["b"] });
    const probed = last() as TrackingReply;
    expect(probed.homography).not.toBeNull();
    expect(probed.probe?.from).toBe("b");
    expect(viewError(probed.probe!.h, truth({ x: WIDTH + 200, y }, { x: WIDTH + 130, y }))).toBeLessThan(2);
  });
});
