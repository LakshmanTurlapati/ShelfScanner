import { token_set_ratio } from "fuzzball";
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
  return token_set_ratio(norm(a), norm(b)) < 90;
}

export function mergeOverlaps(strips: Detection[][], k = 4): Detection[] {
  if (strips.length === 0) return [];
  const out: Detection[] = [...strips[0]];
  for (let s = 1; s < strips.length; s++) {
    for (const d of strips[s]) {
      const tail = out.filter((o) => o.strip === s - 1 && o.shelfRow === d.shelfRow).slice(-k);
      const twin =
        d.position <= k
          ? tail.find(
              (o) =>
                token_set_ratio(norm(o.title), norm(d.title)) >= 90 &&
                !authorsConflict(o.author, d.author),
            )
          : undefined;
      if (!twin) out.push(d);
      else {
        const sharper = d.confidence > twin.confidence ? d : twin;
        const boxSource = interior(d) < interior(twin) ? d : twin;
        out[out.indexOf(twin)] = sharper === boxSource ? sharper : { ...sharper, box: boxSource.box, stripCenter: boxSource.stripCenter };
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
    if (hit) hit.detections.push(...b.detections);
    else byId.set(id, { ...b, key: id, detections: [...b.detections] });
  }
  return [...byId.values()];
}
