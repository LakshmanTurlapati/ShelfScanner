import pLimit from "p-limit";
import type { Book, Detection } from "../../shared/types.ts";
import { embedBooks, enrichBook, readStrip } from "./api";
import { assignMarks, mapStripBox } from "./overlay/geometry";
import { bookKey, mergeCanonical, mergeOverlaps } from "./pipeline/dedup";
import { withScores } from "./pipeline/score";
import { toStrips, type PhotoStrip } from "./pipeline/tiling";
import { useShelf } from "./store";

function detectionFrom(strip: PhotoStrip, index: number, spine: Awaited<ReturnType<typeof readStrip>>["spines"][number]): Detection {
  const hasBox = [spine.x, spine.y, spine.w, spine.h].every((value) => typeof value === "number");
  return {
    strip: index,
    shelfRow: spine.shelf_row,
    position: spine.position,
    spineText: spine.spine_text,
    title: spine.title,
    author: spine.author,
    legible: spine.legible,
    confidence: spine.confidence,
    callNumber: spine.call_number,
    sticker: spine.sticker,
    box: hasBox ? mapStripBox(strip, { x: spine.x!, y: spine.y!, w: spine.w!, h: spine.h! }) : null,
    stripCenter: hasBox ? spine.x! + spine.w! / 2 : null,
  };
}

function detectionKey(detection: Detection) {
  return detection.title.trim()
    ? bookKey(detection.title, detection.author)
    : `unread|${detection.strip}|${detection.shelfRow}|${detection.position}|${detection.box?.x ?? ""}|${detection.box?.y ?? ""}`;
}

function booksFrom(detections: Detection[]): Book[] {
  const grouped = new Map<string, Detection[]>();
  for (const detection of detections) {
    const key = detectionKey(detection);
    grouped.set(key, [...(grouped.get(key) ?? []), detection]);
  }
  return [...grouped].map(([key, group]) => ({
    key,
    detections: group,
    status: "queued",
    canonicalTitle: group[0]?.title ?? null,
    authors: group[0]?.author ? [group[0].author] : [],
    firstPublishedYear: null,
    primaryGenre: null,
    secondaryGenres: [],
    summary: null,
    avgRating: null,
    ratingsCount: null,
    ratingSource: null,
    ratingUrl: null,
    isbn13: null,
    flags: [],
    score: null,
    mark: "",
    box: null,
  }));
}

export async function scanPhotos(files: File[]) {
  const store = useShelf.getState();
  store.beginSession(files.length);
  const perPhoto: Detection[][][] = [];
  let stripTotal = 0;
  let stripDone = 0;
  for (const file of files) {
    let strips: PhotoStrip[];
    try {
      strips = await toStrips(file);
    } catch {
      store.setProgress("This photo could not be read. Use a JPEG.");
      return;
    }
    stripTotal += strips.length;
    const rows = await Promise.all(
      strips.map(async (strip, i) => {
        const json = await readStrip(strip.blob, i + 1, strips.length);
        stripDone += 1;
        store.setProgress(`Reading strip ${stripDone} of ${stripTotal}`);
        return json.spines.map((spine) => detectionFrom(strip, i, spine));
      }),
    );
    perPhoto.push(rows);
  }
  const detections = perPhoto.flatMap((rows) => mergeOverlaps(rows));
  let books = assignMarks(booksFrom(detections));
  store.setBooks(books);
  store.setTab("shelf");

  const limit = pLimit(6);
  let enriched = 0;
  await Promise.all(
    books.map((book) =>
      limit(async () => {
        const detection = [...book.detections].sort((a, b) => b.confidence - a.confidence)[0];
        store.patchBook(book.key, { status: "enriching" });
        try {
          const result = await enrichBook(
            { title: detection?.title ?? book.key, author: detection?.author ?? null, callNumber: detection?.callNumber ?? null },
          );
          const facts = result.facts;
          store.patchBook(book.key, {
            status: facts.matched ? "done" : "unmatched",
            canonicalTitle: facts.canonical_title,
            authors: facts.authors,
            firstPublishedYear: facts.first_published_year,
            primaryGenre: facts.primary_genre,
            secondaryGenres: facts.secondary_genres,
            summary: facts.summary,
            avgRating: facts.avg_rating,
            ratingsCount: facts.ratings_count,
            ratingSource: facts.rating_source,
            ratingUrl: facts.rating_url,
            isbn13: facts.isbn13,
            flags: result.flags,
            embedding: result.embedding,
          });
        } catch (err) {
          store.patchBook(book.key, { status: "error", error: err instanceof Error ? err.message : "failed" });
        }
        enriched += 1;
        store.setProgress(`${enriched} of ${books.length} books`);
      }),
    ),
  );

  books = mergeCanonical(withScores(useShelf.getState().sessions.find((s) => s.id === useShelf.getState().currentId)?.books ?? books));
  store.setBooks(books);

  const items = books
    .filter((book) => book.status === "done" || book.status === "unmatched")
    .map((book) => ({
      key: book.key,
      text: `${book.canonicalTitle ?? book.detections[0]?.title ?? book.key} by ${book.authors.join(", ")}. ${book.primaryGenre ?? ""}; ${book.secondaryGenres.join(", ")}. ${book.summary ?? ""}`,
    }));
  if (items.length) {
    const embedded = await embedBooks(items);
    const byKey = new Map(embedded.items.map((item) => [item.key, item.embedding]));
    store.setBooks(useShelf.getState().sessions.find((s) => s.id === useShelf.getState().currentId)?.books.map((book) => ({
      ...book,
      embedding: byKey.get(book.key) ?? book.embedding,
    })) ?? books);
  }
  store.setProgress("");
}

export async function enrichOne(key: string, title: string, author: string | null) {
  const store = useShelf.getState();
  store.patchBook(key, { status: "enriching", canonicalTitle: title, authors: author ? [author] : [] });
  const result = await enrichBook({ title, author, callNumber: null });
  const facts = result.facts;
  store.patchBook(key, {
    status: facts.matched ? "done" : "unmatched",
    canonicalTitle: facts.canonical_title ?? title,
    authors: facts.authors.length ? facts.authors : author ? [author] : [],
    firstPublishedYear: facts.first_published_year,
    primaryGenre: facts.primary_genre,
    secondaryGenres: facts.secondary_genres,
    summary: facts.summary,
    avgRating: facts.avg_rating,
    ratingsCount: facts.ratings_count,
    ratingSource: facts.rating_source,
    ratingUrl: facts.rating_url,
    isbn13: facts.isbn13,
    flags: result.flags,
  });
  const session = useShelf.getState().sessions.find((item) => item.id === useShelf.getState().currentId);
  if (session) store.setBooks(withScores(session.books));
}
