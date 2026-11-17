import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import { embeddingFrom, embeddingHash, embeddingTo, openCache } from "../cache.ts";
import { readJson } from "../guards.ts";
import { openrouter } from "../openrouter.ts";

const bodySchema = z.object({
  items: z.array(z.object({ key: z.string().max(400), text: z.string().max(4000) })).max(100),
});

const db = openCache();
const lookup = db.prepare("SELECT embedding FROM embeddings WHERE hash = ? AND model = ?");
const saveEmbedding = db.prepare(`
  INSERT INTO embeddings (hash, embedding, model, fetched_at)
  VALUES (@hash, @embedding, @model, @fetched_at)
  ON CONFLICT(hash) DO UPDATE SET embedding = excluded.embedding, model = excluded.model, fetched_at = excluded.fetched_at
`);

export async function embed(c: Context) {
  const parsed = bodySchema.safeParse(await readJson(c));
  if (!parsed.success) return c.text("invalid embed request", 400);
  const found: Array<{ key: string; embedding: number[] }> = [];
  const missing: Array<{ key: string; text: string; hash: string }> = [];
  for (const item of parsed.data.items) {
    const hash = embeddingHash(MODELS.embed, item.text);
    const row = lookup.get(hash, MODELS.embed) as { embedding: Buffer } | undefined;
    const embedding = embeddingFrom(row?.embedding ?? null);
    if (embedding) found.push({ key: item.key, embedding });
    else missing.push({ ...item, hash });
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
        hash: item.hash,
        embedding: embeddingTo(entry.embedding),
        model: MODELS.embed,
        fetched_at: Math.floor(Date.now() / 1000),
      });
      found.push({ key: item.key, embedding: entry.embedding });
    });
  }
  return c.json({ items: found });
}
