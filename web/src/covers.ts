import { httpsCoverUrl, normalizeTitle } from "../../shared/cover-text.ts";
import type { Book } from "../../shared/types.ts";
import { apiUrl } from "./api";
import { useShelf } from "./store";

const CHUNK = 40;

function isbnDigits(value: string) {
  return value.replace(/\D/g, "");
}

function validIsbn13(value: string) {
  const digits = isbnDigits(value);
  if (digits.length !== 13) return false;
  const sum = [...digits].reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
  return sum % 10 === 0;
}

export function coverImageUrl(coverId: number | null | undefined) {
  if (typeof coverId !== "number" || !Number.isInteger(coverId) || coverId <= 0) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

export type CoverAttempt = { index: number; retries: number; failed: boolean };

export function coverSources(book: { coverId?: number | null; coverUrl?: string | null }) {
  const sources: string[] = [];
  const direct = book.coverUrl ? httpsCoverUrl(book.coverUrl) : null;
  if (direct) sources.push(direct);
  const openLibrary = coverImageUrl(book.coverId);
  if (openLibrary && openLibrary !== direct) sources.push(openLibrary);
  return sources;
}

export function coverSrc(sources: readonly string[], attempt: CoverAttempt) {
  if (attempt.failed || attempt.index >= sources.length) return null;
  const base = sources[attempt.index]!;
  if (attempt.retries === 0) return base;
  const url = new URL(base);
  url.searchParams.set("retry", String(attempt.retries));
  return url.toString();
}

export function noteCoverError(sources: readonly string[], attempt: CoverAttempt): CoverAttempt {
  if (attempt.retries < 1) return { ...attempt, retries: attempt.retries + 1 };
  if (attempt.index + 1 < sources.length) return { index: attempt.index + 1, retries: 0, failed: false };
  return { ...attempt, failed: true };
}

// Open Library answers a missing id with HTTP 200 and a one pixel gif, so onError never fires.
export function coverLooksEmpty(image: { naturalWidth: number; naturalHeight: number }) {
  return image.naturalWidth <= 1 || image.naturalHeight <= 1;
}

export function noteCoverMiss(sources: readonly string[], attempt: CoverAttempt): CoverAttempt {
  if (attempt.index + 1 < sources.length) return { index: attempt.index + 1, retries: 0, failed: false };
  return { ...attempt, failed: true };
}

type CoverItem = { isbn: string | null; title: string | null; author: string | null; coverId: number | null; coverUrl?: string | null };

function bookTitle(book: Book) {
  return book.canonicalTitle ?? book.detections[0]?.title ?? "";
}

async function postCovers(books: { isbn: string | null; title: string | null; author: string | null }[]): Promise<CoverItem[] | null> {
  let last: CoverItem[] | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(apiUrl("/api/covers"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ books }),
      });
      if (res.ok) {
        const body = (await res.json()) as { items?: CoverItem[] };
        return Array.isArray(body.items) ? body.items : [];
      }
      if (res.status !== 429 && res.status < 500) return [];
      last = null;
    } catch {
      last = null;
    }
  }
  return last;
}

async function requestCovers(books: { isbn: string | null; title: string | null; author: string | null }[]) {
  const collected: CoverItem[] = [];
  for (let index = 0; index < books.length; index += CHUNK) {
    const items = await postCovers(books.slice(index, index + CHUNK));
    if (items == null) return null;
    collected.push(...items);
  }
  return collected;
}

function matches(book: Book, item: CoverItem) {
  const isbn = book.isbn13 && validIsbn13(book.isbn13) ? isbnDigits(book.isbn13) : "";
  if (isbn && item.isbn === isbn) return true;
  const title = normalizeTitle(bookTitle(book));
  const author = normalizeTitle(book.authors[0] ?? "");
  return Boolean(title) && item.title === title && (item.author ?? "") === author;
}

// Writes a cover id, a direct https url, or an explicit miss. A failed request leaves the book unset.
export async function fillCovers(sessionId: string) {
  const session = useShelf.getState().sessions.find((item) => item.id === sessionId);
  if (!session || session.contract !== 1) return;
  const pending = session.books.filter((book) => {
    if (book.coverId !== undefined || book.coverUrl !== undefined) return false;
    if (book.isbn13 && validIsbn13(book.isbn13)) return true;
    return Boolean(normalizeTitle(bookTitle(book)));
  });
  if (!pending.length) return;
  const queries = pending.map((book) => ({
    isbn: book.isbn13 && validIsbn13(book.isbn13) ? isbnDigits(book.isbn13) : null,
    title: bookTitle(book) || null,
    author: book.authors[0] ?? null,
  }));
  let items: CoverItem[] | null = [];
  try {
    items = await requestCovers(queries);
  } catch {
    return;
  }
  if (!items) return;
  for (const book of pending) {
    const item = items.find((candidate) => matches(book, candidate));
    if (!item) continue;
    const coverId = item.coverId;
    const legalId = coverId === null || (typeof coverId === "number" && Number.isInteger(coverId) && coverId > 0);
    const coverUrl = item.coverUrl == null ? null : httpsCoverUrl(item.coverUrl);
    if (!legalId || (item.coverUrl != null && !coverUrl)) continue;
    useShelf.getState().patchBookFor(sessionId, book.key, { coverId, coverUrl });
  }
}
