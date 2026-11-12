import Database from "better-sqlite3";
import { isValidIsbn13 } from "./verify.ts";

type Sqlite = InstanceType<typeof Database>;

const HIT_TTL_SECONDS = 30 * 24 * 60 * 60;
const MISS_TTL_SECONDS = 24 * 60 * 60;
const COVER_ID = /\/b\/id\/(\d+)-[SML]\.jpg/;

export type CoverAnswer = { isbn: string; coverId: number | null };

type CoverRow = { cover_id: number | null; fetched_at: number };

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

function fresh(row: CoverRow | undefined, now: number) {
  if (!row) return false;
  const ttl = row.cover_id == null ? MISS_TTL_SECONDS : HIT_TTL_SECONDS;
  return now - row.fetched_at < ttl;
}

// Cached ids and checked misses are returned without another request. A failed
// request omits those ISBNs so the phone can try again. Image bytes are never read.
export async function resolveCovers(
  db: Sqlite,
  isbns: readonly string[],
  fetchImpl: typeof fetch,
  now = () => Math.floor(Date.now() / 1000),
): Promise<CoverAnswer[]> {
  const lookup = db.prepare("SELECT cover_id, fetched_at FROM covers WHERE isbn = ?");
  const save = db.prepare(`
    INSERT INTO covers (isbn, cover_id, fetched_at) VALUES (?, ?, ?)
    ON CONFLICT(isbn) DO UPDATE SET cover_id = excluded.cover_id, fetched_at = excluded.fetched_at
  `);
  const answers = new Map<string, number | null>();
  const needed: string[] = [];
  const seen = new Set<string>();
  const stamp = now();
  for (const raw of isbns) {
    const isbn = raw.replace(/\D/g, "");
    if (!isbn || seen.has(isbn)) continue;
    seen.add(isbn);
    if (!isValidIsbn13(isbn)) {
      answers.set(isbn, null);
      continue;
    }
    const row = lookup.get(isbn) as CoverRow | undefined;
    if (fresh(row, stamp)) answers.set(isbn, row!.cover_id);
    else needed.push(isbn);
  }
  if (needed.length) {
    const bibkeys = needed.map((isbn) => `ISBN:${isbn}`).join(",");
    const url = `https://openlibrary.org/api/books?bibkeys=${encodeURIComponent(bibkeys)}&format=json&jscmd=data`;
    try {
      const res = await fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        const payload: unknown = await res.json();
        for (const isbn of needed) {
          const coverId = coverIdFromBooksPayload(payload, isbn);
          save.run(isbn, coverId, stamp);
          answers.set(isbn, coverId);
        }
      }
    } catch {
      // Leave the ISBN unset. The next scan can ask again.
    }
  }
  const ordered: CoverAnswer[] = [];
  const emitted = new Set<string>();
  for (const raw of isbns) {
    const isbn = raw.replace(/\D/g, "");
    if (!isbn || emitted.has(isbn) || !answers.has(isbn)) continue;
    emitted.add(isbn);
    ordered.push({ isbn, coverId: answers.get(isbn) ?? null });
  }
  return ordered;
}
