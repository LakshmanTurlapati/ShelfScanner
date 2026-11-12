import type { Context } from "hono";
import { z } from "zod";
import { openCache } from "../cache.ts";
import { resolveCovers } from "../covers.ts";

const bodySchema = z.object({
  isbns: z.array(z.string().max(32)).min(1).max(40),
});

const db = openCache();

export async function covers(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text("invalid isbns", 400);
  const started = Date.now();
  const items = await resolveCovers(db, parsed.data.isbns, fetch);
  console.log(JSON.stringify({ route: "/api/covers", items: items.length, ms: Date.now() - started }));
  return c.json({ items });
}
