import type { Book, Pin } from "../../shared/types.ts";
import { sameTitle } from "./overlay/anchors.ts";
import { applyHomography, invertHomography, projectAnchor, type Mat3 } from "./overlay/track.ts";
import { authorsConflict, norm } from "./pipeline/dedup.ts";
import { finitePin, pinSection } from "./pin.ts";

// A walk is one session of reads from the live view. It lasts while the app is open and survives
// opening the Shelf; it ends after a long idle, when its session goes, or from New walk.
export const WALK_IDLE_MS = 30 * 60_000;

type Walk = {
  id: string;
  section: number;
  highest: number;
  lastAt: number;
  direction: 1 | -1;
  latest: string | null;
  position: { section: number; x: number } | null;
  /** Where the direction was last decided; small jitter around it says nothing. */
  turnedAt: number | null;
};

let walk: Walk | null = null;
const ended = new Set<() => void>();

export function currentWalk(now = Date.now()) {
  if (walk && now - walk.lastAt > WALK_IDLE_MS) endWalk();
  return walk?.id ?? null;
}

export function continueWalk(id: string, now = Date.now()) {
  if (walk && walk.id !== id) endWalk();
  walk ??= { id, section: 1, highest: 1, lastAt: now, direction: 1, latest: null, position: null, turnedAt: null };
  walk.lastAt = now;
}

export function endWalk() {
  const had = walk !== null || roots.size > 0;
  walk = null;
  roots.clear();
  frames.clear();
  if (had) for (const callback of [...ended]) callback();
}

export function onWalkEnd(callback: () => void) {
  ended.add(callback);
  return () => {
    ended.delete(callback);
  };
}

/** The walk's session id, without ending an idle walk (safe to call while rendering). */
export const activeWalk = () => walk?.id ?? null;

export const walkSection = () => walk?.section ?? 1;

/** New shelf: the next read starts a section numbered after every one used so far. */
export function startSection() {
  if (!walk) return 1;
  walk.highest += 1;
  walk.section = walk.highest;
  walk.position = null;
  walk.turnedAt = null;
  return walk.section;
}

/** Walking back onto an earlier shelf makes it the current one again. */
export function enterSection(section: number) {
  if (!walk || !Number.isInteger(section) || section < 1) return;
  walk.section = section;
  walk.highest = Math.max(walk.highest, section);
}

// A fifth of a frame either way decides which way the walk is going.
const TURN = 0.2;

export const walkDirection = () => walk?.direction ?? 1;

/** Where the centre of the view is now, in shelf coordinates, while tracking holds. */
export function notePosition(section: number, x: number) {
  if (!walk || !Number.isFinite(x)) return;
  if (walk.position?.section !== section || walk.turnedAt === null) walk.turnedAt = x;
  else if (Math.abs(x - walk.turnedAt) >= TURN) {
    walk.direction = x > walk.turnedAt ? 1 : -1;
    walk.turnedAt = x;
  }
  walk.position = { section, x };
}

export function walkPosition() {
  if (walk?.position) return walk.position;
  const latest = walk?.latest ? framePlace(walk.latest) : null;
  return latest ? { section: latest.section, x: latest.x + 0.5 } : null;
}

// Every read has a place: the shelf x of its frame's left edge, a row offset (rows are counted per
// frame from the top shelf it sees) and a section. Reads the tracker has linked move as one group,
// spaced by their tracked offsets, so placing any one of them places them all.
export type PlaceSource = "guess" | "titles" | "fixed";
export type Place = { x: number; rowOffset: number; section: number };
type Root = Place & { source: PlaceSource };

// "fixed" is the first read of a section, which defines x = 0; matched titles beat a guess.
const RANK: Record<PlaceSource, number> = { guess: 0, titles: 1, fixed: 2 };
const roots = new Map<string, Root>();
const frames = new Map<string, { root: string; offset: number }>();
type FramesMoved = (frameIds: string[], before: ReadonlyMap<string, Place>) => void;
const moved = new Set<FramesMoved>();

const memberOf = (frameId: string) => frames.get(frameId) ?? { root: frameId, offset: 0 };
const framesOf = (root: string) => [...frames].filter(([, member]) => member.root === root).map(([id]) => id);

function placesOf(frameIds: readonly string[]) {
  const out = new Map<string, Place>();
  for (const id of frameIds) {
    const place = framePlace(id);
    if (place) out.set(id, { x: place.x, rowOffset: place.rowOffset, section: place.section });
  }
  return out;
}

function announce(frameIds: string[], before: ReadonlyMap<string, Place>) {
  if (!frameIds.length) return;
  for (const callback of [...moved]) callback(frameIds, before);
}

/**
 * Called with the reads whose place changed and where they were before, so their pins can move by
 * the same amount (a book a later read saw again no longer has this read's detection to re-pin from).
 */
export function onFramesMoved(callback: FramesMoved) {
  moved.add(callback);
  return () => {
    moved.delete(callback);
  };
}

export function framePlace(frameId: string): (Place & { source: PlaceSource }) | null {
  const member = frames.get(frameId);
  const root = member && roots.get(member.root);
  if (!member || !root) return null;
  return { x: root.x + member.offset, rowOffset: root.rowOffset, section: root.section, source: root.source };
}

/** A weaker source never moves a read placed by a stronger one; returns whether anything moved. */
export function placeFrame(frameId: string, place: Place, source: PlaceSource) {
  const member = memberOf(frameId);
  frames.set(frameId, member);
  const old = roots.get(member.root);
  if (old && RANK[old.source] > RANK[source]) return false;
  const next: Root = { x: place.x - member.offset, rowOffset: place.rowOffset, section: place.section, source };
  if (old && old.source === source && Math.abs(old.x - next.x) < 1e-6 && old.rowOffset === next.rowOffset && old.section === next.section) return false;
  const group = framesOf(member.root);
  const before = placesOf(group);
  roots.set(member.root, next);
  announce(group, before);
  return true;
}

/** A read beginning: its first place, and the walk's latest read. */
export function startFrame(frameId: string, place: Place, source: PlaceSource) {
  if (walk) walk.latest = frameId;
  placeFrame(frameId, place, source);
}

/**
 * Links `frameId`'s group to `intoFrameId`'s: `offset` is how far right frameId's frame starts from
 * intoFrameId's, in frame widths. The better-placed group keeps its place and the other follows.
 */
export function joinFrames(frameId: string, intoFrameId: string, offset: number) {
  if (!Number.isFinite(offset)) return false;
  const from = memberOf(frameId);
  const into = memberOf(intoFrameId);
  frames.set(frameId, from);
  frames.set(intoFrameId, into);
  if (from.root === into.root) return false;
  const delta = into.offset + offset - from.offset;
  const fromRoot = roots.get(from.root);
  const intoRoot = roots.get(into.root);
  const joining = framesOf(from.root);
  const before = placesOf([...joining, ...framesOf(into.root)]);
  for (const id of joining) frames.set(id, { root: into.root, offset: frames.get(id)!.offset + delta });
  roots.delete(from.root);
  if (fromRoot && (!intoRoot || RANK[fromRoot.source] > RANK[intoRoot.source])) {
    roots.set(into.root, { ...fromRoot, x: fromRoot.x - delta });
    announce(framesOf(into.root), before);
  } else announce(joining, before);
  return true;
}

export const walkLatest = () => walk?.latest ?? null;

// Positive when the camera walks toward the right of the shelf: the old center has moved left in the frame.
export function shelfShift(homography: Mat3, width: number, height: number) {
  const point = projectAnchor(homography, 0.5, 0.5, width, height);
  const shift = 0.5 - point.x;
  return Number.isFinite(shift) ? shift : 0;
}

/** Where the frame that `homography` maps the keyframe into starts, in keyframe widths from the keyframe's left edge. */
export function frameOffset(homography: Mat3, width: number, height: number) {
  const point = applyHomography(invertHomography(homography), width / 2, height / 2);
  const offset = point.x / width - 0.5;
  return Number.isFinite(offset) ? offset : 0;
}

export function pinFor(book: Book, detection = book.detections.find((item) => item.box) ?? book.detections[0]): Pin | null {
  if (!detection) return null;
  const local = detection.box ? detection.box.x + detection.box.w / 2 : detection.position;
  const place = (detection.captureId ? framePlace(detection.captureId) : null) ?? (walk?.latest ? framePlace(walk.latest) : null);
  const x = (place?.x ?? 0) + local;
  const row = detection.shelfRow + (place?.rowOffset ?? 0);
  if (!Number.isFinite(x) || !Number.isFinite(row)) return null;
  const pin: Pin = { x, row, section: place?.section ?? walkSection() };
  if (detection.captureId) pin.frame = detection.captureId;
  return pin;
}

const TITLE_AGREE = 0.15;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Places a read from the books it shares with reads already placed in the same section: each
 * shared title says where this frame starts. Needs two that agree, since one lookup can be wrong;
 * a title read twice on either side says nothing about which copy is which. Reads already linked
 * into this read's group are left out: they only repeat the group's own place, guessed or not.
 */
export function anchorByTitles(stored: readonly Book[], incoming: readonly Book[], frameId: string, section: number) {
  const readings = incoming.flatMap((book) => {
    const detection = book.detections.find((item) => item.captureId === frameId && item.box && item.legible && item.title.trim());
    return detection?.box ? [{ title: detection.title.trim(), author: detection.author, u: detection.box.x + detection.box.w / 2, row: detection.shelfRow }] : [];
  });
  const copies = new Map<string, number>();
  for (const reading of readings) copies.set(norm(reading.title), (copies.get(norm(reading.title)) ?? 0) + 1);
  const group = memberOf(frameId).root;
  const placed = stored.filter((book) =>
    finitePin(book.pin) && pinSection(book.pin) === section && (!book.pin.frame || memberOf(book.pin.frame).root !== group));
  const offsets: { x: number; row: number }[] = [];
  for (const reading of readings) {
    if ((copies.get(norm(reading.title)) ?? 0) > 1) continue;
    const hits = placed.filter((book) => {
      const names = [book.canonicalTitle, book.detections[0]?.title].filter((name): name is string => Boolean(name?.trim()));
      if (!names.some((name) => sameTitle(name, reading.title))) return false;
      return !authorsConflict(book.authors[0] ?? book.detections[0]?.author ?? null, reading.author);
    });
    if (hits.length !== 1) continue;
    const pin = hits[0].pin!;
    offsets.push({ x: pin.x - reading.u, row: pin.row - reading.row });
  }
  if (offsets.length < 2) return null;
  const middle = median(offsets.map((item) => item.x));
  const agree = offsets.filter((item) => Math.abs(item.x - middle) <= TITLE_AGREE);
  if (agree.length < 2) return null;
  return { x: median(agree.map((item) => item.x)), rowOffset: Math.round(median(agree.map((item) => item.row))) };
}
