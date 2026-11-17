import Database from "better-sqlite3";
import pLimit from "p-limit";
import { httpsCoverUrl, normalizeTitle } from "../shared/cover-text.ts";
import { isValidIsbn13 } from "./verify.ts";

export { httpsCoverUrl, normalizeTitle };

type Sqlite = InstanceType<typeof Database>;

const HIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MISS_TTL_SECONDS = 24 * 60 * 60;
const COVER_ID = /\/b\/id\/(\d+)-[SML]\.jpg/;

export type CoverLookup = { isbn?: string | null; title?: string | null; author?: string | null };
export type CoverAnswer = {
  isbn: string | null;
  title: string | null;
  author: string | null;
  coverId: number | null;
  coverUrl: string | null;
};

type CoverRow = { cover_id: number | null; cover_url: string | null; fetched_at: number };
type FetchResult = { status: number; body: unknown | null; transient: boolean };

export function coverIdFromBooksPayload(payload: unknown, isbn: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const entry = (payload as Record<string, unknown>)[`ISBN:${isbn}`];
  if (!entry || typeof entry !== "object") return null;
  const cover = (entry as { cover?: unknown }).cover;
  if (!cover || typeof cover !== "object") return null;
  for (const size of ["large", "medium", "small"]) {
    const url = (cover as Record<string, unknown>)[size];
    if (typeof url !== "string") continue;
    const match = COVER_ID.exec(url);
    if (match) return Number(match[1]);
  }
  return null;
}

export function coverIdFromSearch(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const docs = (payload as { docs?: unknown }).docs;
  if (!Array.isArray(docs)) return null;
  for (const doc of docs) {
    if (!doc || typeof doc !== "object") continue;
    const id = (doc as { cover_i?: unknown }).cover_i;
    if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
  }
  return null;
}

export function coverUrlFromGoogle(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    const links = (item as { volumeInfo?: { imageLinks?: Record<string, unknown> } })?.volumeInfo?.imageLinks;
    if (!links) continue;
    for (const size of ["extraLarge", "large", "medium", "small", "thumbnail", "smallThumbnail"]) {
      const value = links[size];
      if (typeof value !== "string") continue;
      const url = httpsCoverUrl(value.replace("&edge=curl", ""));
      if (url) return url;
    }
  }
  return null;
}

function fresh(row: CoverRow | undefined, now: number) {
  if (!row) return false;
  const ttl = row.cover_id == null && !row.cover_url ? MISS_TTL_SECONDS : HIT_TTL_SECONDS;
  return now - row.fetched_at < ttl;
}

function isbnDigits(value: string | null | undefined) {
  const digits = (value ?? "").replace(/\D/g, "");
  return isValidIsbn13(digits) ? digits : null;
}

export function coverCacheKey(lookup: CoverLookup) {
  const isbn = isbnDigits(lookup.isbn);
  if (isbn) return isbn;
  const title = normalizeTitle(lookup.title ?? "");
  if (!title) return null;
  return `t:${title}|${normalizeTitle(lookup.author ?? "")}`;
}

async function readJson(fetchImpl: typeof fetch, url: string): Promise<FetchResult> {
  try {
    const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (res.status === 429 || res.status >= 500) return { status: res.status, body: null, transient: true };
    if (!res.ok) return { status: res.status, body: null, transient: false };
    return { status: res.status, body: await res.json(), transient: false };
  } catch {
    return { status: 0, body: null, transient: true };
  }
}

function searchUrl(isbn: string | null, title: string, author: string) {
  const params = new URLSearchParams({ limit: "1", fields: "cover_i" });
  if (isbn) params.set("isbn", isbn);
  else {
    params.set("title", title);
    if (author) params.set("author", author);
  }
  return `https://openlibrary.org/search.json?${params.toString()}`;
}

function googleUrl(isbn: string | null, title: string, author: string) {
  const query = isbn ? `isbn:${isbn}` : [`intitle:${title}`, author ? `inauthor:${author}` : ""].filter(Boolean).join(" ");
  const params = new URLSearchParams({ q: query, maxResults: "1", fields: "items(volumeInfo/imageLinks)" });
  return `https://www.googleapis.com/books/v1/volumes?${params.toString()}`;
}

// Cached ids and checked misses are returned without another request. A failed
// request omits that book so the phone can try again. Image bytes are never read.
// Each book can wait on Open Library and then Google Books, so books are looked up a few at a
// time and the request stops waiting at a deadline. A book still pending then is omitted like any
// other failed lookup, and the phone asks again later.
export type CoverOptions = { concurrency?: number; deadlineMs?: number };

export async function resolveCoverQueries(
  db: Sqlite,
  lookups: readonly CoverLookup[],
  fetchImpl: typeof fetch,
  now = () => Math.floor(Date.now() / 1000),
  { concurrency = 6, deadlineMs = 25_000 }: CoverOptions = {},
): Promise<CoverAnswer[]> {
  const lookup = db.prepare("SELECT cover_id, cover_url, fetched_at FROM covers WHERE isbn = ?");
  const save = db.prepare(`
    INSERT INTO covers (isbn, cover_id, cover_url, fetched_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(isbn) DO UPDATE SET cover_id = excluded.cover_id, cover_url = excluded.cover_url, fetched_at = excluded.fetched_at
  `);
  const stamp = now();
  const prepared: { key: string; isbn: string | null; title: string; author: string }[] = [];
  const seen = new Set<string>();
  const answers = new Map<string, CoverAnswer>();
  for (const raw of lookups) {
    const isbn = isbnDigits(raw.isbn);
    const title = normalizeTitle(raw.title ?? "");
    const author = normalizeTitle(raw.author ?? "");
    const key = coverCacheKey({ isbn, title, author });
    if (!key) {
      const digits = (raw.isbn ?? "").replace(/\D/g, "");
      if (digits) answers.set(`bad:${digits}`, { isbn: digits, title: null, author: null, coverId: null, coverUrl: null });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    if (!isbn && !title) continue;
    const row = lookup.get(key) as CoverRow | undefined;
    if (fresh(row, stamp)) {
      answers.set(key, {
        isbn,
        title: title || null,
        author: author || null,
        coverId: row!.cover_id,
        coverUrl: row!.cover_url ? httpsCoverUrl(row!.cover_url) : null,
      });
    } else prepared.push({ key, isbn, title, author });
  }

  const neededIsbn = prepared.filter((item) => item.isbn).map((item) => item.isbn!);
  const fromBooks = new Map<string, number | null>();
  let booksTransient = false;
  if (neededIsbn.length) {
    const bibkeys = neededIsbn.map((isbn) => `ISBN:${isbn}`).join(",");
    const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=data`;
    const result = await readJson(fetchImpl, url);
    booksTransient = result.transient;
    if (!result.transient) {
      for (const isbn of neededIsbn) fromBooks.set(isbn, coverIdFromBooksPayload(result.body, isbn));
    }
  }

  let expired = false;
  const lookUp = async (item: (typeof prepared)[number]) => {
    if (expired || answers.has(item.key)) return;
    const direct = item.isbn ? fromBooks.get(item.isbn) : undefined;
    if (typeof direct === "number") {
      save.run(item.key, direct, null, stamp);
      answers.set(item.key, { isbn: item.isbn, title: item.title || null, author: item.author || null, coverId: direct, coverUrl: null });
      return;
    }
    let transient = item.isbn ? booksTransient && direct === undefined : false;
    let foundId: number | null = null;
    let foundUrl: string | null = null;
    if (item.isbn || item.title) {
      const search = await readJson(fetchImpl, searchUrl(item.isbn, item.title, item.author));
      if (search.transient) transient = true;
      else foundId = coverIdFromSearch(search.body);
      if (!foundId && !expired) {
        const google = await readJson(fetchImpl, googleUrl(item.isbn, item.title, item.author));
        if (google.transient) transient = true;
        else foundUrl = coverUrlFromGoogle(google.body);
      }
    }
    if (expired) return;
    if (!foundId && !foundUrl && transient) return;
    save.run(item.key, foundId, foundUrl, stamp);
    answers.set(item.key, { isbn: item.isbn, title: item.title || null, author: item.author || null, coverId: foundId, coverUrl: foundUrl });
  };
  const limit = pLimit(concurrency);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  await Promise.race([Promise.all(prepared.map((item) => limit(() => lookUp(item)))), deadline]);
  expired = true;
  clearTimeout(timer);
  limit.clearQueue();

  const ordered: CoverAnswer[] = [];
  const emitted = new Set<string>();
  for (const raw of lookups) {
    const key = coverCacheKey(raw) ?? `bad:${(raw.isbn ?? "").replace(/\D/g, "")}`;
    if (!key || emitted.has(key) || !answers.has(key)) continue;
    emitted.add(key);
    ordered.push(answers.get(key)!);
  }
  return ordered;
}

export async function resolveCovers(
  db: Sqlite,
  isbns: readonly string[],
  fetchImpl: typeof fetch,
  now = () => Math.floor(Date.now() / 1000),
): Promise<CoverAnswer[]> {
  return resolveCoverQueries(db, isbns.map((isbn) => ({ isbn })), fetchImpl, now);
}
