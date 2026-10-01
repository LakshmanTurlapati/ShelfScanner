import { ratio } from "fuzzball";
import pLimit from "p-limit";
import { norm } from "../web/src/pipeline/dedup.ts";

const ORIGIN = "https://www.goodreads.com";
const USER_AGENT = "ShelfScanner/1.0 (+https://shelf-scanner.fly.dev)";
const TIMEOUT_MS = 1200;
const limit = pLimit(8);

export type QuickFacts = {
  matched: true;
  canonical_title: string;
  authors: string[];
  avg_rating: number | null;
  ratings_count: number | null;
  rating_source: "goodreads";
  rating_url: string;
};

export type GoodreadsItem = {
  title?: unknown;
  bookTitleBare?: unknown;
  author?: { name?: unknown };
  avgRating?: unknown;
  ratingsCount?: unknown;
  bookUrl?: unknown;
};

const text = (value: unknown) => (typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "");

export function cleanTitle(title: string) {
  return title.replace(/\bvol(?:ume)?\b\.?\s*(?:\d+|[ivxlc]+\b)/gi, " ").replace(/\s+/g, " ").replace(/^[\s,.:;-]+|[\s,.:;-]+$/g, "");
}

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);

function surname(author: string | null) {
  const words = author ? norm(author).split(" ").filter((word) => !SUFFIXES.has(word)) : [];
  return words.pop() ?? "";
}

// "The Hobbit, or There and Back Again" needs the comma cut; "Guns, Germs, and Steel" must not get it.
const mainTitles = (title: string) => [title.split(/[:(]| \/ /)[0], title.split(/[:(]|, | \/ /)[0]];

function titleMatches(item: GoodreadsItem, spineTitle: string) {
  const bare = text(item.bookTitleBare) || text(item.title);
  if (mainTitles(bare).some((main) => norm(main) && ratio(norm(main), spineTitle) >= 88)) return true;
  // "Series Name: Title" lists the series first.
  const colon = bare.indexOf(":");
  return colon > 0 && mainTitles(bare.slice(colon + 1)).some((main) => norm(main) === spineTitle);
}

// The candidate's surname must be a word printed on the spine ("KING & STRAUB"), or start
// with one that a strip edge cut short ("THACKERA"). First names never count.
function authorMatches(item: GoodreadsItem, spineAuthor: string | null) {
  const words = spineAuthor ? norm(spineAuthor).split(" ").filter((word) => word.length > 1) : [];
  if (!words.length) return true;
  const last = surname(text(item.author?.name));
  return last.length > 1 && words.some((word) => word === last || (word.length >= 5 && last.startsWith(word)));
}

function ratingUrl(bookUrl: unknown) {
  if (typeof bookUrl !== "string" || !bookUrl.startsWith("/")) return null;
  try {
    const url = new URL(bookUrl, ORIGIN);
    return url.origin === ORIGIN ? `${ORIGIN}${url.pathname}` : null;
  } catch {
    return null;
  }
}

// Picks the most-rated candidate whose main title matches the spine, so a companion
// book ("The Art of The Hobbit") never outranks the book itself.
export function pickRating(items: GoodreadsItem[], title: string, author: string | null): QuickFacts | null {
  const spineTitle = norm(cleanTitle(title));
  if (!spineTitle) return null;
  const count = (item: GoodreadsItem) => (Number.isInteger(item.ratingsCount) ? (item.ratingsCount as number) : 0);
  const best = items
    .filter((item) => item && typeof item === "object" && titleMatches(item, spineTitle) && authorMatches(item, author))
    .sort((a, b) => count(b) - count(a))[0];
  if (!best) return null;
  const rating = Number(best.avgRating);
  const url = ratingUrl(best.bookUrl);
  if (!(rating >= 1 && rating <= 5) || count(best) <= 0 || !url) return null;
  const name = text(best.author?.name);
  return {
    matched: true,
    canonical_title: text(best.bookTitleBare) || text(best.title),
    authors: name ? [name] : [],
    avg_rating: rating,
    ratings_count: count(best),
    rating_source: "goodreads",
    rating_url: url,
  };
}

// Goodreads' undocumented search-box endpoint. Never throws: null means Goodreads could not
// be reached in time or answered with something unreadable, so the caller should not cache it.
export function searchGoodreads(title: string, author: string | null, { signal }: { signal?: AbortSignal } = {}) {
  return limit(async (): Promise<GoodreadsItem[] | null> => {
    if (signal?.aborted) return null;
    const query = `${cleanTitle(title)} ${surname(author)}`.trim();
    try {
      const timeout = AbortSignal.timeout(TIMEOUT_MS);
      const res = await fetch(`${ORIGIN}/book/auto_complete?format=json&q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!res.ok) return null;
      const items: unknown = await res.json();
      return Array.isArray(items) ? (items as GoodreadsItem[]) : null;
    } catch {
      return null;
    }
  });
}

// Null means no match; undefined means Goodreads could not answer, which is not worth caching.
export async function lookupRating(title: string, author: string | null, options: { signal?: AbortSignal } = {}) {
  const items = await searchGoodreads(title, author, options);
  if (!items) return undefined;
  const facts = pickRating(items, title, author);
  if (facts || !author) return facts;
  // Goodreads reorders its suggestions from call to call, and study guides can crowd out
  // the book itself; the title alone often brings it back.
  const retry = await searchGoodreads(title, null, options);
  return retry ? pickRating(retry, title, author) : null;
}

export async function quickRating(title: string, author: string | null, options: { signal?: AbortSignal } = {}) {
  return (await lookupRating(title, author, options)) ?? null;
}
