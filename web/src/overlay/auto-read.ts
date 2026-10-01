import { frameDiff } from "./steady";
import type { GrayFrame } from "./track";

export const AUTO_READ_KEY = "shelf-scanner-auto-read";
const MIN_GAP_MS = 3000;
const MAX_MISSES = 5;
// A view this different from the last read's is a new view. The same view is read again only
// after a while, since its labels can be lost to tracking rather than to a bad read.
const NEW_VIEW_DIFF = 0.05;
const SAME_VIEW_RETRY_MS = 8000;

export type AutoReadGate = {
  enabled: boolean;
  steady: boolean;
  reading: boolean;
  visible: boolean;
  /** A tracked capture already shows labels for this view. */
  covered: boolean;
  /** A details or review sheet is open; a read would close it. */
  sheetOpen: boolean;
  now: number;
};

function sameView(a: GrayFrame | null, b: GrayFrame | null) {
  return Boolean(a && b && a.width === b.width && a.height === b.height && frameDiff(a, b) <= NEW_VIEW_DIFF);
}

export function createAutoRead() {
  let misses = 0;
  let lastStart = -Infinity;
  let pending: GrayFrame | null = null;
  let last: { frame: GrayFrame | null; at: number; labelled: boolean } | null = null;
  return {
    due(gate: AutoReadGate, frame: GrayFrame | null) {
      if (!gate.enabled || !gate.steady || !gate.visible || gate.reading || gate.covered || gate.sheetOpen) return false;
      if (misses >= MAX_MISSES || gate.now - lastStart < MIN_GAP_MS) return false;
      return !last || !last.labelled || !sameView(last.frame, frame) || gate.now - last.at >= SAME_VIEW_RETRY_MS;
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
