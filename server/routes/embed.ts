import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import { PROMPT_VERSION } from "../../shared/models.ts";
import { embeddingFrom, embeddingTo, openCache, type CacheRow } from "../cache.ts";
import { openrouter } from "../openrouter.ts";

const bodySchema = z.object({
  items: z.array(z.object({ key: z.string().max(400), text: z.string().max(4000) })).max(100),
});

const db = openCache();
const lookup = db.prepare("SELECT * FROM books WHERE key = ?");
const saveEmbedding = db.prepare(`
  INSERT INTO books (key, canonical_key, record, embedding, model, prompt_version, fetched_at)
  VALUES (@key, NULL, '{}', @embedding, @model, @prompt_version, @fetched_at)
  ON CONFLICT(key) DO UPDATE SET embedding = excluded.embedding
`);

export async function embed(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json());
  if (!parsed.success) return c.text("invalid embed request", 400);
  const found: Array<{ key: string; embedding: number[] }> = [];
  const missing: Array<{ key: string; text: string }> = [];
  for (const item of parsed.data.items) {
    const row = lookup.get(item.key) as CacheRow | undefined;
    const embedding = embeddingFrom(row?.embedding ?? null);
    if (embedding && row?.model) found.push({ key: item.key, embedding });
    else missing.push(item);
  }
  if (missing.length > 0) {
    const json = await openrouter("/embeddings", {
      model: MODELS.embed,
      input: missing.map((item) => item.text),
    });
    const data = (json?.data ?? []) as Array<{ embedding: number[]; index: number }>;
    data.forEach((entry, index) => {
      const item = missing[entry.index ?? index];
      if (!item || !entry.embedding) return;
      saveEmbedding.run({
        key: item.key,
        embedding: embeddingTo(entry.embedding),
        model: MODELS.embed,
        prompt_version: PROMPT_VERSION,
        fetched_at: Math.floor(Date.now() / 1000),
      });
      found.push({ key: item.key, embedding: entry.embedding });
    });
  }
  return c.json({ items: found });
}
