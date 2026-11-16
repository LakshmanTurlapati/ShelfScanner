import type { Context } from "hono";
import { z } from "zod";
import { openCache } from "../cache.ts";
import { resolveCoverQueries, type CoverLookup } from "../covers.ts";

const bookSchema = z.object({
  isbn: z.string().max(32).nullable().optional(),
  title: z.string().max(300).nullable().optional(),
  author: z.string().max(200).nullable().optional(),
});

const bodySchema = z
  .object({
    isbns: z.array(z.string().max(32)).max(40).optional(),
    books: z.array(bookSchema).max(40).optional(),
  })
  .refine((body) => (body.isbns?.length ?? 0) + (body.books?.length ?? 0) > 0, { message: "empty" });

const db = openCache();

export async function covers(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.text("invalid isbns", 400);
  const lookups: CoverLookup[] = parsed.data.books?.length
    ? parsed.data.books.map((book) => ({ isbn: book.isbn, title: book.title, author: book.author }))
    : (parsed.data.isbns ?? []).map((isbn) => ({ isbn }));
  const started = Date.now();
  const items = await resolveCoverQueries(db, lookups, fetch);
  console.log(JSON.stringify({ route: "/api/covers", items: items.length, ms: Date.now() - started }));
  return c.json({ items });
}
