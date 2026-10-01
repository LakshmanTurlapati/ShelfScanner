import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import type { BookFactsInput } from "../../shared/schemas.ts";
import type { Flag } from "../../shared/types.ts";
import { bookKey } from "../../web/src/pipeline/dedup.ts";
import { fresh, openCache, quickFresh, type CacheRow, type QuickRow } from "../cache.ts";
import { lookupRating, type QuickFacts } from "../goodreads.ts";

const DEADLINE_MS = 1500;

const bodySchema = z.object({
  items: z.array(z.object({
    key: z.string(),
    title: z.string().max(200),
    author: z.string().max(200).nullable().optional(),
  })).min(1).max(30),
});

type Answer = { verified: boolean; facts: BookFactsInput | QuickFacts | null; flags: Flag[] };

const db = openCache();
const lookupBook = db.prepare("SELECT * FROM books WHERE key = ?");
const lookupQuick = db.prepare("SELECT * FROM quick_facts WHERE key = ?");
const saveQuick = db.prepare(`
  INSERT INTO quick_facts (key, record, fetched_at) VALUES (?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET record = excluded.record, fetched_at = excluded.fetched_at
`);

function stored(key: string): Answer | null {
  const book = lookupBook.get(key) as CacheRow | undefined;
  if (fresh(book, MODELS.enrich)) {
    const record = JSON.parse(book!.record) as { facts: BookFactsInput; flags: Flag[] };
    return { verified: true, facts: record.facts, flags: record.flags };
  }
  const quick = lookupQuick.get(key) as QuickRow | undefined;
  return quickFresh(quick) ? { verified: false, facts: JSON.parse(quick!.record), flags: [] } : null;
}

// Books already looked up come from the cache; the rest get a Goodreads rating if one
// arrives before the deadline. A lookup that fails or runs late is not cached.
export async function quickFacts(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text("invalid items", 400);
  const started = Date.now();
  const signal = AbortSignal.any([AbortSignal.timeout(DEADLINE_MS), c.req.raw.signal]);
  const counts = { verified: 0, cached: 0, fetched: 0, failed: 0 };
  const items = await Promise.all(parsed.data.items.map(async ({ key, title, author = null }) => {
    const cacheKey = bookKey(title, author);
    const hit = stored(cacheKey);
    if (hit) {
      counts[hit.verified ? "verified" : "cached"]++;
      return { key, ...hit };
    }
    const facts = title.trim() ? await lookupRating(title, author, { signal }) : undefined;
    if (facts === undefined) {
      counts.failed++;
      return { key, verified: false, facts: null, flags: [] };
    }
    saveQuick.run(cacheKey, JSON.stringify(facts), Math.floor(Date.now() / 1000));
    counts.fetched++;
    return { key, verified: false, facts, flags: [] };
  }));
  console.log(JSON.stringify({ route: "/api/quick-facts", items: items.length, ...counts, ms: Date.now() - started }));
  return c.json({ items });
}
