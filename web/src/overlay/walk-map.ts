import { applyHomography, composeHomography, IDENTITY, invertHomography, normalize, type Mat3 } from "./track";

// The reads of a walk, joined wherever the tracker saw one turn into the next. A bookcase front is
// close to a plane, so the homographies chain: every read in a group maps into the group's first
// keyframe (its root), and any read's labels can be drawn in a view tracked against another.

export type MapNode = {
  captureId: string;
  /** Creation order; a newer read's labels win over an older one's. */
  seq: number;
  root: string;
  /** This read's keyframe pixels to the root keyframe's. */
  toRoot: Mat3;
  width: number;
  height: number;
  section: number;
};

export type WalkMap = { nodes: Map<string, MapNode>; seq: number };

export const createWalkMap = (): WalkMap => ({ nodes: new Map(), seq: 0 });

export function addRoot(map: WalkMap, captureId: string, width: number, height: number, section: number) {
  const node: MapNode = { captureId, seq: ++map.seq, root: captureId, toRoot: IDENTITY, width, height, section };
  map.nodes.set(captureId, node);
  return node;
}

/** `h` maps `fromId`'s keyframe into the new read's keyframe. Null when the frames differ in size. */
export function linkNode(map: WalkMap, captureId: string, fromId: string, h: Mat3, width: number, height: number) {
  const from = map.nodes.get(fromId);
  if (!from || from.width !== width || from.height !== height) return null;
  const node: MapNode = {
    captureId,
    seq: ++map.seq,
    root: from.root,
    toRoot: normalize(composeHomography(from.toRoot, invertHomography(h))),
    width,
    height,
    section: from.section,
  };
  map.nodes.set(captureId, node);
  return node;
}

/** `nodeId`'s keyframe into the current view, given `hActive` from the active read's keyframe. */
export function toCurrent(map: WalkMap, nodeId: string, activeId: string, hActive: Mat3): Mat3 | null {
  const node = map.nodes.get(nodeId);
  const active = map.nodes.get(activeId);
  if (!node || !active || node.root !== active.root) return null;
  if (nodeId === activeId) return hActive;
  return normalize(composeHomography(hActive, composeHomography(invertHomography(active.toRoot), node.toRoot)));
}

/**
 * Both reads are in view: `hActive` and `hMatched` map their keyframes into the same frame. The
 * active read's group joins the matched read's. Returns the reads that moved, or null.
 */
export function mergeRoots(map: WalkMap, activeId: string, hActive: Mat3, matchedId: string, hMatched: Mat3) {
  const active = map.nodes.get(activeId);
  const matched = map.nodes.get(matchedId);
  if (!active || !matched || active.root === matched.root || active.width !== matched.width || active.height !== matched.height) return null;
  const from = active.root;
  // Active root -> active keyframe -> this frame -> matched keyframe -> matched root.
  const bridge = composeHomography(matched.toRoot, composeHomography(invertHomography(hMatched), composeHomography(hActive, invertHomography(active.toRoot))));
  const moved: string[] = [];
  for (const node of map.nodes.values()) {
    if (node.root !== from) continue;
    node.root = matched.root;
    node.toRoot = normalize(composeHomography(bridge, node.toRoot));
    moved.push(node.captureId);
  }
  return moved;
}

/** How far right `nodeId`'s frame starts from `relativeId`'s, in frame widths. */
export function offsetBetween(map: WalkMap, nodeId: string, relativeId: string) {
  const node = map.nodes.get(nodeId);
  const relative = map.nodes.get(relativeId);
  if (!node || !relative || node.root !== relative.root) return null;
  const toRelative = composeHomography(invertHomography(relative.toRoot), node.toRoot);
  const centre = applyHomography(toRelative, node.width / 2, node.height / 2);
  const offset = centre.x / relative.width - 0.5;
  return Number.isFinite(offset) ? offset : null;
}

export function removeNode(map: WalkMap, captureId: string) {
  map.nodes.delete(captureId);
}

/** Drops the oldest reads beyond `max`, never one in `keep`; returns the ids dropped. */
export function evict(map: WalkMap, max: number, keep: ReadonlySet<string>) {
  const dropped: string[] = [];
  const oldest = [...map.nodes.values()].filter((node) => !keep.has(node.captureId)).sort((a, b) => a.seq - b.seq);
  while (map.nodes.size > max && oldest.length) {
    const node = oldest.shift()!;
    map.nodes.delete(node.captureId);
    dropped.push(node.captureId);
  }
  return dropped;
}

export type Projected = { node: MapNode; h: Mat3 };

function quadArea(points: { x: number; y: number }[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

/**
 * The active group's reads close enough to the view to place labels: the keyframe centre lands
 * within one view of the screen and the chained transform is not a wild extrapolation. Oldest first.
 */
export function nearbyNodes(map: WalkMap, activeId: string, hActive: Mat3, width: number, height: number): Projected[] {
  const active = map.nodes.get(activeId);
  if (!active) return [];
  const out: Projected[] = [];
  for (const node of map.nodes.values()) {
    if (node.root !== active.root) continue;
    const h = toCurrent(map, node.captureId, activeId, hActive);
    if (!h || !h.every(Number.isFinite)) continue;
    const centre = applyHomography(h, width / 2, height / 2);
    if (centre.x < -width || centre.x > 2 * width || centre.y < -height || centre.y > 2 * height) continue;
    const corners = [[0, 0], [width, 0], [width, height], [0, height]].map(([x, y]) => applyHomography(h, x, y));
    const scale = Math.sqrt(quadArea(corners) / (width * height));
    if (!(scale >= 0.5 && scale <= 2)) continue;
    out.push({ node, h });
  }
  return out.sort((a, b) => a.node.seq - b.node.seq);
}

export type Crop = { x0: number; y0: number; x1: number; y1: number };

/** Share of the visible part of the view (a 5x5 grid of points) inside at least one of these reads' frames. */
export function coverage(projected: readonly Projected[], width: number, height: number, crop: Crop) {
  if (!projected.length) return 0;
  const inverses = projected.map((item) => invertHomography(item.h));
  let inside = 0;
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 5; j++) {
      const x = (crop.x0 + ((crop.x1 - crop.x0) * (i + 0.5)) / 5) * width;
      const y = (crop.y0 + ((crop.y1 - crop.y0) * (j + 0.5)) / 5) * height;
      if (inverses.some((inverse) => {
        const point = applyHomography(inverse, x, y);
        return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
      })) inside++;
    }
  }
  return inside / 25;
}

export type Placed = { id: string; seq: number; x: number; y: number; spine: number };

/**
 * One label per spine across reads: an older read's label is dropped when a newer read placed one
 * within a little over half a spine of it. Two labels from the same read are both kept.
 */
export function dropShadowed<T extends Placed>(targets: readonly T[]): T[] {
  return targets.filter((target) => !targets.some((other) =>
    other.seq > target.seq && Math.hypot(other.x - target.x, other.y - target.y) <= 0.6 * Math.max(4, Math.min(other.spine, target.spine))));
}
