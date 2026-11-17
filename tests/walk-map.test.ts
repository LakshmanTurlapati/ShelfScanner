import { describe, expect, it } from "vitest";
import { visibleBounds } from "../web/src/overlay/geometry.ts";
import { applyHomography, IDENTITY, type Mat3 } from "../web/src/overlay/track.ts";
import {
  addRoot,
  coverage,
  createWalkMap,
  dropShadowed,
  evict,
  linkNode,
  mergeRoots,
  nearbyNodes,
  offsetBetween,
  toCurrent,
} from "../web/src/overlay/walk-map.ts";

const W = 480;
const H = 853;

// Keyframe pixels into a view `dx` pixels to the right (content moves left), zoomed by `zoom` about the centre.
function moved(dx: number, zoom = 1): Mat3 {
  return [zoom, 0, (1 - zoom) * W / 2 - dx * zoom, 0, zoom, (1 - zoom) * H / 2, 0, 0, 1];
}

function near(h: Mat3, expected: Mat3) {
  for (const [x, y] of [[10, 10], [W / 2, H / 2], [W - 10, H - 10]]) {
    const a = applyHomography(h, x, y);
    const b = applyHomography(expected, x, y);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeLessThan(1e-6);
  }
}

describe("walk map", () => {
  it("chains reads so any read's keyframe maps into the current view", () => {
    const map = createWalkMap();
    addRoot(map, "a", W, H, 1);
    // b was read 200 px right of a, zoomed in a little; c 150 px right of b.
    linkNode(map, "b", "a", moved(200, 1.1), W, H);
    linkNode(map, "c", "b", moved(150), W, H);
    expect(map.nodes.get("c")!.root).toBe("a");
    // The view is tracked against c, 30 px further right.
    const view = moved(30);
    near(toCurrent(map, "c", "c", view)!, view);
    // a's keyframe reaches the view through b and c.
    const viaChain = toCurrent(map, "a", "c", view)!;
    const expected = [moved(200, 1.1), moved(150), view].reduce<Mat3>((acc, step) => {
      const out = Array<number>(9);
      for (let r = 0; r < 3; r++) for (let col = 0; col < 3; col++) out[r * 3 + col] = step[r * 3] * acc[col] + step[r * 3 + 1] * acc[3 + col] + step[r * 3 + 2] * acc[6 + col];
      return out as Mat3;
    }, IDENTITY);
    near(viaChain, expected.map((value) => value / expected[8]) as Mat3);
    expect(offsetBetween(map, "c", "a")).toBeGreaterThan(0.6);
  });

  it("joins two groups when reads from both are in the same view", () => {
    const map = createWalkMap();
    addRoot(map, "a", W, H, 1);
    linkNode(map, "b", "a", moved(240), W, H);
    addRoot(map, "x", W, H, 1);
    linkNode(map, "y", "x", moved(100), W, H);
    // The view shows y (tracked, 20 px on) and b (found 40 px on from b).
    const moves = mergeRoots(map, "y", moved(20), "b", moved(40));
    expect(moves?.sort()).toEqual(["x", "y"]);
    expect(map.nodes.get("x")!.root).toBe("a");
    // Now y's keyframe sits 20 px left of b's, so the view maps through b exactly as found.
    near(toCurrent(map, "b", "y", moved(20))!, moved(40));
    expect(mergeRoots(map, "y", moved(20), "b", moved(40))).toBeNull();
  });

  it("lists only the group's reads near the view, oldest first, and never another size", () => {
    const map = createWalkMap();
    addRoot(map, "a", W, H, 1);
    linkNode(map, "b", "a", moved(300), W, H);
    linkNode(map, "far", "b", moved(W * 3), W, H);
    expect(linkNode(map, "small", "a", moved(10), 240, 427)).toBeNull();
    addRoot(map, "other", W, H, 1);
    const ids = nearbyNodes(map, "b", moved(0), W, H).map((item) => item.node.captureId);
    expect(ids).toEqual(["a", "b"]);
  });

  it("measures how much of the visible view earlier reads already cover", () => {
    const map = createWalkMap();
    addRoot(map, "a", W, H, 1);
    const full = { x0: 0, y0: 0, x1: 1, y1: 1 };
    expect(coverage(nearbyNodes(map, "a", IDENTITY, W, H), W, H, full)).toBe(1);
    // Walked 60% of a frame right: only the left two of five columns are inside a's frame.
    expect(coverage(nearbyNodes(map, "a", moved(W * 0.6), W, H), W, H, full)).toBeCloseTo(0.4);
    expect(coverage([], W, H, full)).toBe(0);
  });

  it("finds the part of the frame a cover-fitted screen shows", () => {
    // A 9:16 portrait frame on a taller screen: the sides are cropped.
    const crop = visibleBounds(360, 800, 480, 853);
    expect(crop.y0).toBeCloseTo(0);
    expect(crop.x0).toBeGreaterThan(0);
    expect(crop.x1).toBeCloseTo(1 - crop.x0);
  });

  it("drops the oldest reads first and keeps the ones in use", () => {
    const map = createWalkMap();
    for (const id of ["a", "b", "c", "d"]) addRoot(map, id, W, H, 1);
    expect(evict(map, 2, new Set(["a"]))).toEqual(["b", "c"]);
    expect([...map.nodes.keys()]).toEqual(["a", "d"]);
  });

  it("keeps one label per spine across reads, the newer read's", () => {
    const targets = [
      { id: "old", seq: 1, x: 100, y: 200, spine: 30 },
      { id: "new", seq: 2, x: 108, y: 204, spine: 30 },
      { id: "twin", seq: 2, x: 112, y: 206, spine: 30 },
      { id: "apart", seq: 1, x: 200, y: 200, spine: 30 },
    ];
    expect(dropShadowed(targets).map((item) => item.id)).toEqual(["new", "twin", "apart"]);
  });
});
