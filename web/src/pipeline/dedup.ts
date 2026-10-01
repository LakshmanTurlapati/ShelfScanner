import { partial_ratio, token_set_ratio } from "fuzzball";
import type { Book, Detection } from "../../../shared/types.ts";

export const norm = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(the|a|an) /, "");

function interior(d: Detection) {
  if (d.stripCenter == null) return 1;
  return Math.abs(d.stripCenter - 0.5);
}

function authorsConflict(a: string | null, b: string | null) {
  if (!a || !b) return false;
  // Initials and strip edges vary the reading ("W.M. Thackeray", "WM.THACKERA"), so compare letters only.
  const compact = (s: string) => norm(s).replace(/ /g, "");
  return partial_ratio(compact(a), compact(b)) < 85;
}

function samePhysicalSpine(a: Detection, b: Detection) {
  if (!a.box || !b.box) return false;
  const x = Math.max(0, Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x));
  const y = Math.max(0, Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y));
  const smaller = Math.min(a.box.w * a.box.h, b.box.w * b.box.h);
  const shared = smaller > 0 ? x * y / smaller : 0;
  const centerGap = Math.abs(a.box.x + a.box.w / 2 - b.box.x - b.box.w / 2);
  // A spine cut by a strip edge gets a shorter box in each strip, so their centers drift apart;
  // a strong overlap is enough on its own.
  return shared >= 0.7 || (shared >= 0.45 && centerGap <= Math.min(a.box.w, b.box.w) * 0.5);
}

// Each strip sees only part of a spine that the seam between them cuts.
function cutBySeam(left: Detection, right: Detection) {
  if (!left.stripSpan || !right.stripSpan || !left.box || !right.box) return false;
  const shared = Math.min(left.box.x + left.box.w, right.box.x + right.box.w) - Math.max(left.box.x, right.box.x);
  return left.stripSpan[1] >= 0.98 && right.stripSpan[0] <= 0.02 && shared > 0;
}

// A merged twin keeps the id already on screen (`shown`), else the left strip's, so its label is not redrawn.
function twinId(left: Detection, right: Detection, shown: ReadonlySet<string>) {
  return right.id && shown.has(right.id) && !(left.id && shown.has(left.id)) ? right.id : left.id;
}

// Row numbers can differ between strips, so twins in the overlap are matched by their boxes.
export function mergeOverlaps(strips: Detection[][], shown: ReadonlySet<string> = new Set()): Detection[] {
  if (strips.length === 0) return [];
  const out: Detection[] = [...strips[0]];
  for (let s = 1; s < strips.length; s++) {
    for (const d of strips[s]) {
      const twin = out.find(
        (o) =>
          o.strip === s - 1 &&
          (samePhysicalSpine(o, d) || cutBySeam(o, d)) &&
          token_set_ratio(norm(o.title), norm(d.title)) >= 90 &&
          !authorsConflict(o.author, d.author),
      );
      if (!twin) out.push(d);
      else {
        const sharper = d.confidence > twin.confidence ? d : twin;
        const boxSource = interior(d) < interior(twin) ? d : twin;
        const merged = sharper === boxSource ? sharper : { ...sharper, box: boxSource.box, stripCenter: boxSource.stripCenter };
        const id = twinId(twin, d, shown);
        out[out.indexOf(twin)] = merged.id === id ? merged : { ...merged, id };
      }
    }
  }
  return out;
}

export function bookKey(title: string, author: string | null) {
  return `${norm(title)}|${norm(author ?? "")}`;
}

export function mergeCanonical(books: Book[]): Book[] {
  const byId = new Map<string, Book>();
  for (const b of books) {
    const id = b.canonicalTitle
      ? `${norm(b.canonicalTitle)}|${norm(b.authors[0] ?? "")}`
      : b.key;
    const hit = byId.get(id);
    if (hit) {
      hit.detections.push(...b.detections);
      hit.flags = [...new Set([...hit.flags, ...b.flags])];
    }
    else byId.set(id, { ...b, key: id, detections: [...b.detections] });
  }
  return [...byId.values()];
}
