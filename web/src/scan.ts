import pLimit from "p-limit";
import type { BookFactsInput } from "../../shared/schemas.ts";
import type { Book, Detection, Flag } from "../../shared/types.ts";
import { embedBooks, enrichBook, quickFacts, readStrip, type QuickFactsItem, type SpineResponse } from "./api";
import { anchorsForCapture, labelable } from "./overlay/anchors";
import { assignMarks, mapStripBox } from "./overlay/geometry";
import { bookKey, mergeCanonical, mergeOverlaps } from "./pipeline/dedup";
import { withScores } from "./pipeline/score";
import { stripsFromCanvas, toStrips, type PhotoStrip } from "./pipeline/tiling";
import { renamedKeys, useShelf } from "./store";

export type ScanTiming = "strips-encoded" | "first-label" | "all-labels" | "first-rating" | "all-ratings";
export type ScanOptions = {
  captureId?: string;
  /** performance.now() of the tap; timings are measured from here. */
  startedAt?: number;
  onTiming?: (name: ScanTiming, ms: number) => void;
};
/** `settled` resolves once every lookup for the scan has finished; it never rejects. */
export type ScanResult = { captureId: string; settled: Promise<void> };

const LOOKUP_CONCURRENCY = 20;
const QUICK_FACTS_BATCH = 30;
// Enrichment waits this long for quick facts, so books the cache already verified skip it.
const QUICK_GRACE_MS = 1500;
const EMBED_BATCH = 100;

function detectionFrom(strip: PhotoStrip, captureId: string, photoIndex: number, index: number, k: number, spine: SpineResponse["spines"][number]): Detection {
  const hasBox = [spine.x, spine.y, spine.w, spine.h].every((value) => typeof value === "number");
  return {
    id: `${captureId}:${photoIndex}:${index}:${k}`,
    captureId,
    photoIndex,
    placement: spine.placement ?? (hasBox ? "matched" : "unmatched-text"),
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
    stripSpan: hasBox ? [spine.x!, spine.x! + spine.w!] : null,
  };
}

function detectionKey(detection: Detection) {
  return detection.title.trim()
    ? bookKey(detection.title, detection.author)
    : `unread|${detection.id ?? `${detection.strip}|${detection.shelfRow}|${detection.position}`}`;
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
    status: group.some((item) => item.title.trim() && item.legible && item.confidence >= 0.5) ? "queued" : "unmatched",
    canonicalTitle: group[0]?.title.trim() || null,
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

function verifiedPatch(facts: BookFactsInput, flags: Flag[]): Partial<Book> {
  return {
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
    flags,
  };
}

function quickPatch(item: QuickFactsItem): Partial<Book> | null {
  if (!item.facts) return null;
  if (item.verified) return verifiedPatch(item.facts, item.flags);
  if (item.facts.avg_rating == null) return null;
  return { avgRating: item.facts.avg_rating, ratingsCount: item.facts.ratings_count, ratingSource: "goodreads", ratingUrl: item.facts.rating_url };
}

function sharpest(book: Book) {
  return [...book.detections].sort((a, b) => b.confidence - a.confidence)[0];
}

function sessionBooks(captureId: string) {
  return useShelf.getState().sessions.find((session) => session.id === captureId)?.books ?? [];
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function stopwatch(startedAt: number, onTiming: ScanOptions["onTiming"]) {
  const seen = new Set<ScanTiming>();
  return (name: ScanTiming) => {
    if (seen.has(name)) return;
    seen.add(name);
    onTiming?.(name, Math.round(performance.now() - startedAt));
  };
}

// Reads every strip at once and shows each strip's books the moment it returns, then looks them up.
async function readSession(captureId: string, photos: PhotoStrip[][], tick: (name: ScanTiming) => void): Promise<ScanResult> {
  const store = useShelf.getState();
  const rows = photos.map((strips) => strips.map((): Detection[] => []));
  const total = photos.reduce((sum, strips) => sum + strips.length, 0);
  const limit = pLimit(LOOKUP_CONCURRENCY);
  const started = new Set<string>();
  const verified = new Set<string>();
  const queue: Book[] = [];
  const lookups: Promise<unknown>[] = [];
  // Lookups still in flight for a book that a later strip renamed land on its new key.
  const renamed = new Map<string, string>();
  const current = (key: string): string => (renamed.has(key) ? current(renamed.get(key)!) : key);
  let stripsDone = 0;
  let stripsRead = 0;
  let lookedUp = 0;

  const progress = () => store.setProgressFor(captureId, stripsDone < total
    ? `Reading strip ${stripsDone} of ${total}`
    : `${lookedUp} of ${started.size} books`);

  const patch = (key: string, next: Partial<Book>) => {
    store.patchBookFor(captureId, key, next);
    const book = sessionBooks(captureId).find((item) => item.key === key);
    if (book?.avgRating != null && anchorsForCapture([book], captureId).some((anchor) => anchor.showRating)) tick("first-rating");
  };

  const applyQuick = (items: QuickFactsItem[]) => {
    for (const item of items) {
      const key = current(item.key);
      const next = verified.has(key) ? null : quickPatch(item);
      if (!next) continue;
      if (item.verified) verified.add(key);
      patch(key, next);
    }
  };

  // Picks at run time, so a labelled book from a later strip still goes before unlabelled ones.
  const enrichNext = async () => {
    const pick = queue.findIndex((book) => book.detections.some(labelable));
    const [queued] = queue.splice(pick >= 0 ? pick : 0, 1);
    const book = queued && sessionBooks(captureId).find((item) => item.key === current(queued.key));
    if (book && !verified.has(book.key)) {
      const detection = sharpest(book);
      store.patchBookFor(captureId, book.key, { status: "enriching" });
      try {
        const result = await enrichBook({ title: detection?.title ?? book.key, author: detection?.author ?? null, callNumber: detection?.callNumber ?? null });
        const key = current(book.key);
        verified.add(key);
        patch(key, { ...verifiedPatch(result.facts, result.flags), embedding: result.embedding });
      } catch (err) {
        const key = current(book.key);
        if (!verified.has(key)) store.patchBookFor(captureId, key, { status: "error", error: err instanceof Error ? err.message : "failed" });
      }
    }
    lookedUp += 1;
    progress();
  };

  const lookUp = (books: Book[]) => {
    const fresh = books.filter((book) => book.status === "queued" && !started.has(book.key));
    if (!fresh.length) return;
    const stored = new Map(sessionBooks(captureId).map((book) => [book.key, book]));
    for (const book of fresh) {
      started.add(book.key);
      // A sharper twin from another strip can make a book readable after it was first stored as unmatched.
      if (stored.get(book.key)?.status !== "queued") store.patchBookFor(captureId, book.key, { status: "queued" });
    }
    const items = fresh.map((book) => {
      const detection = sharpest(book);
      return { key: book.key, title: (detection?.title.trim() || book.key).slice(0, 200), author: detection?.author?.slice(0, 200) ?? null };
    });
    const batches = Array.from({ length: Math.ceil(items.length / QUICK_FACTS_BATCH) }, (_, i) => items.slice(i * QUICK_FACTS_BATCH, (i + 1) * QUICK_FACTS_BATCH));
    const quick = Promise.all(batches.map((batch) => quickFacts(batch).then((result) => applyQuick(result.items)).catch(() => undefined)));
    const enrich = Promise.race([quick, delay(QUICK_GRACE_MS)]).then(() => {
      queue.push(...fresh);
      return Promise.all(fresh.map(() => limit(enrichNext)));
    });
    lookups.push(quick, enrich);
  };

  const show = () => {
    const known = new Set(sessionBooks(captureId).flatMap((book) => book.detections.flatMap((detection) => detection.id ? [detection.id] : [])));
    const books = assignMarks(booksFrom(rows.flatMap((strips) => mergeOverlaps(strips, known))));
    if (!books.length) return;
    if (!known.size && useShelf.getState().currentId === captureId) store.setTab("shelf");
    for (const [from, to] of renamedKeys(sessionBooks(captureId), books)) {
      renamed.set(from, to);
      if (started.has(from)) started.add(to);
      if (verified.has(from)) verified.add(to);
    }
    store.mergeBooksFor(captureId, books);
    if (books.some((book) => book.detections.some(labelable))) tick("first-label");
    lookUp(books);
  };

  await Promise.all(photos.flatMap((strips, photoIndex) => strips.map(async (strip, i) => {
    let spines: SpineResponse["spines"] = [];
    try {
      spines = (await readStrip(strip.blob, i + 1, strips.length)).spines;
      stripsRead += 1;
    } catch {
      // Keep usable strips when one model request fails.
    }
    stripsDone += 1;
    progress();
    rows[photoIndex][i] = spines.map((spine, k) => detectionFrom(strip, captureId, photoIndex, i, k, spine));
    show();
  })));
  tick("all-labels");

  if (!stripsRead) {
    store.removeSession(captureId);
    throw new Error("The shelf could not be read. Try again.");
  }
  if (!rows.some((strips) => strips.some((detections) => detections.length))) {
    store.removeSession(captureId);
    throw new Error("No spines were found. Move closer and read the shelf again.");
  }
  const settled = Promise.all(lookups)
    .then(() => {
      tick("all-ratings");
      return finishSession(captureId);
    })
    .catch(() => undefined);
  return { captureId, settled };
}

async function finishSession(captureId: string) {
  const store = useShelf.getState();
  let books = mergeCanonical(withScores(sessionBooks(captureId)));
  store.setBooksFor(captureId, books);

  const items = books
    .filter((book) => book.canonicalTitle && (book.status === "done" || book.status === "unmatched"))
    .map((book) => ({
      key: book.key,
      text: `${book.canonicalTitle} by ${book.authors.join(", ")}. ${book.primaryGenre ?? ""}; ${book.secondaryGenres.join(", ")}. ${book.summary ?? ""}`,
    }));
  if (items.length) {
    try {
      const batches = Array.from({ length: Math.ceil(items.length / EMBED_BATCH) }, (_, i) => items.slice(i * EMBED_BATCH, (i + 1) * EMBED_BATCH));
      const embedded = (await Promise.all(batches.map(embedBooks))).flatMap((result) => result.items);
      const byKey = new Map(embedded.map((item) => [item.key, item.embedding]));
      books = (useShelf.getState().sessions.find((s) => s.id === captureId)?.books ?? books).map((book) => ({
        ...book,
        embedding: byKey.get(book.key) ?? book.embedding,
      }));
      store.setBooksFor(captureId, books);
    } catch {
      // Enrichment remains useful when the map embedding service is unavailable.
    }
  }
  store.setProgressFor(captureId, "");
}

export async function scanPhotos(files: File[], options: ScanOptions = {}): Promise<ScanResult> {
  const store = useShelf.getState();
  const tick = stopwatch(options.startedAt ?? performance.now(), options.onTiming);
  const captureId = options.captureId ?? crypto.randomUUID();
  store.beginSession(files.length, captureId);
  let photoStrips: PhotoStrip[][];
  try {
    photoStrips = await Promise.all(files.map((file) => toStrips(file)));
  } catch {
    store.removeSession(captureId);
    throw new Error("This photo could not be read. Use a JPEG.");
  }
  tick("strips-encoded");
  return readSession(captureId, photoStrips, tick);
}

export async function scanCanvas(canvas: HTMLCanvasElement | OffscreenCanvas, options: ScanOptions = {}): Promise<ScanResult> {
  const store = useShelf.getState();
  const tick = stopwatch(options.startedAt ?? performance.now(), options.onTiming);
  const captureId = options.captureId ?? crypto.randomUUID();
  store.beginSession(1, captureId);
  let strips: PhotoStrip[];
  try {
    strips = await stripsFromCanvas(canvas, { longEdge: 1600, quality: 0.8 });
  } catch (error) {
    store.removeSession(captureId);
    throw error;
  }
  tick("strips-encoded");
  return readSession(captureId, [strips], tick);
}

export async function enrichOne(key: string, title: string, author: string | null) {
  const store = useShelf.getState();
  const sessionId = store.currentId;
  if (!sessionId) return;
  store.patchBookFor(sessionId, key, { status: "enriching", canonicalTitle: title, authors: author ? [author] : [] });
  const result = await enrichBook({ title, author, callNumber: null });
  const facts = result.facts;
  store.patchBookFor(sessionId, key, {
    ...verifiedPatch(facts, result.flags),
    canonicalTitle: facts.canonical_title ?? title,
    authors: facts.authors.length ? facts.authors : author ? [author] : [],
  });
  const session = useShelf.getState().sessions.find((item) => item.id === sessionId);
  if (session) store.setBooksFor(sessionId, withScores(session.books));
}
