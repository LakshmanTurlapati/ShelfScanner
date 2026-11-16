import { token_sort_ratio } from "fuzzball";
import type { Book, Detection, NormBox } from "../../../shared/types.ts";
import { norm } from "../pipeline/dedup";

export type SpineAnchor = { id: string; box: NormBox; book: Book; title: string; showRating: boolean };

export function labelable(detection: Detection) {
  return Boolean(
    detection.placement === "matched" &&
    detection.box &&
    detection.id &&
    detection.legible &&
    detection.title.trim() &&
    detection.confidence >= 0.75,
  );
}

const VOLUME = /\bvol(?:ume)?\b\.?\s*(?:\d+|[ivxlc]+\b)/gi;

// A title up to its subtitle or series, with and without its ", or ..." alternative title.
const mainTitles = (title: string) =>
  [title.split(/[:(]/)[0], title.split(/[:(]|, /)[0]].map((part) => norm(part.replace(VOLUME, " "))).filter(Boolean);

// A lookup can land on another book, even a sequel or companion whose title contains the
// spine's ("Children of Dune" -> "Dune"), so both main titles must match each other.
// An empty side does not agree. titleAgrees still treats a missing canonical title as
// "show the rating", which is a different question from "is this the preferred book".
export function sameTitle(left: string, right: string) {
  const a = left.trim();
  const b = right.trim();
  if (!a || !b) return false;
  const fromLeft = mainTitles(a);
  const fromRight = mainTitles(b);
  return fromLeft.some((part) => fromRight.some((other) => token_sort_ratio(part, other) >= 85));
}

export function titleAgrees(book: Book, reading: string) {
  const canonical = book.canonicalTitle?.trim();
  if (!canonical) return true;
  return sameTitle(canonical, reading);
}

export function labelTitle(book: Book, reading: string) {
  const canonical = book.canonicalTitle?.trim();
  return canonical && titleAgrees(book, reading) ? canonical : reading;
}

export function anchorsForCapture(books: Book[], captureId: string): SpineAnchor[] {
  return books.flatMap((book) => {
    const mismatch = book.flags.includes("possible_mismatch");
    return book.detections.flatMap((detection) => {
      if (detection.captureId !== captureId || !labelable(detection)) return [];
      const reading = detection.title.trim();
      const showRating = !mismatch && titleAgrees(book, reading);
      return [{ id: detection.id!, box: detection.box!, book, title: labelTitle(book, reading), showRating }];
    });
  });
}
