import { frameDiff } from "./steady";
import type { GrayFrame } from "./track";

export const AUTO_READ_KEY = "shelf-scanner-auto-read";
const MIN_GAP_MS = 3000;
const MAX_MISSES = 5;
// A view this different from the last read's is a new view. The same view is read again only
// after a while, since its labels can be lost to tracking rather than to a bad read.
const NEW_VIEW_DIFF = 0.05;
const SAME_VIEW_RETRY_MS = 8000;
/** Share of the view that labelled reads already cover, above which nothing new is in view. */
export const COVERED = 0.6;
/** Sharpness a frame needs to be read while the camera moves (steady.ts: sharp shelves ~0.65, an 8px blur ~0.12). */
export const MOVING_SHARPNESS = 0.3;

export type AutoReadGate = {
  enabled: boolean;
  /** Held still long enough, with enough detail. */
  steady: boolean;
  /** A sharp, detailed moment, good enough to read without holding still. */
  sharp: boolean;
  reading: boolean;
  visible: boolean;
  /** Share of the visible view inside reads that gave labels (0 when tracking is lost). */
  coverage: number;
  /** Earlier reads near here have not been ruled out yet; finding one brings its labels back without a read. */
  awaitingRelocation: boolean;
  /** A details or review sheet is open; a read would close it. */
  sheetOpen: boolean;
  now: number;
};

function sameView(a: GrayFrame | null, b: GrayFrame | null) {
  return Boolean(a && b && a.width === b.width && a.height === b.height && frameDiff(a, b) <= NEW_VIEW_DIFF);
}

/** True for a sharp sample that is at least nearly the sharpest of the last few, so a moving read starts on a crisp frame. */
export function sharpMoment(sharpness: number, recent: readonly number[]) {
  return sharpness >= MOVING_SHARPNESS && sharpness >= 0.9 * Math.max(sharpness, ...recent);
}

export function createAutoRead() {
  let misses = 0;
  let lastStart = -Infinity;
  let pending: GrayFrame | null = null;
  let last: { frame: GrayFrame | null; at: number; labelled: boolean } | null = null;
  return {
    due(gate: AutoReadGate, frame: GrayFrame | null) {
      if (!gate.enabled || !gate.visible || gate.reading || gate.sheetOpen) return false;
      if (misses >= MAX_MISSES || gate.now - lastStart < MIN_GAP_MS) return false;
      if (gate.awaitingRelocation || gate.coverage >= COVERED) return false;
      const repeat = last !== null && last.labelled && sameView(last.frame, frame) && gate.now - last.at < SAME_VIEW_RETRY_MS;
      return !repeat && (gate.sharp || gate.steady);
    },
    started(now: number, frame: GrayFrame | null) {
      lastStart = now;
      pending = frame;
    },
    // Reading the same view again, or reading nothing, counts toward the pause.
    finished(auto: boolean, labelled: boolean, now: number) {
      const repeat = last !== null && sameView(last.frame, pending);
      if (auto) misses = labelled && !repeat ? 0 : misses + 1;
      last = { frame: pending, at: now, labelled };
      pending = null;
    },
    resume() {
      misses = 0;
    },
    paused: () => misses >= MAX_MISSES,
  };
}
