import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import { BookFacts, BOOK_JSON_SCHEMA } from "../../shared/schemas.ts";
import { PROMPT_VERSION } from "../../shared/models.ts";
import { embeddingFrom, fresh, openCache, type CacheRow } from "../cache.ts";
import { capped } from "../guards.ts";
import { openrouter } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";
import { normalizeFacts, verify } from "../verify.ts";
import { bookKey } from "../../web/src/pipeline/dedup.ts";
import { GENRES } from "../../shared/types.ts";

const rules = readPrompt("enrich.md").replace("{{genres}}", GENRES.join(", "));
const bodySchema = z.object({
  title: z.string(),
  author: z.string().nullable().optional(),
  callNumber: z.string().nullable().optional(),
});

const db = openCache();
const lookup = db.prepare("SELECT * FROM books WHERE key = ?");
const save = db.prepare(`
  INSERT INTO books (key, canonical_key, record, embedding, model, prompt_version, fetched_at)
  VALUES (@key, @canonical_key, @record, @embedding, @model, @prompt_version, @fetched_at)
  ON CONFLICT(key) DO UPDATE SET
    canonical_key = excluded.canonical_key,
    record = excluded.record,
    embedding = COALESCE(excluded.embedding, books.embedding),
    model = excluded.model,
    prompt_version = excluded.prompt_version,
    fetched_at = excluded.fetched_at
`);

function payload(title: string, author: string | null, callNumber: string | null, withTool: boolean) {
  return {
    model: MODELS.enrich,
    messages: [
      { role: "system", content: rules },
      { role: "user", content: `Title: ${title}\nAuthor: ${author ?? "unknown"}\nCall number: ${callNumber ?? "none"}` },
    ],
    ...(withTool
      ? {
          tools: [
            {
              type: "openrouter:web_search",
              parameters: {
                engine: "exa",
                mode: "fast",
                max_uses: 1,
                max_results: 5,
                max_characters: 2000,
                allowed_domains: ["goodreads.com", "openlibrary.org", "books.google.com", "wikipedia.org"],
              },
            },
          ],
        }
      : {}),
    response_format: {
      type: "json_schema",
      json_schema: { name: "book", strict: true, schema: BOOK_JSON_SCHEMA },
    },
    provider: { require_parameters: true },
    plugins: [{ id: "response-healing" }],
    reasoning: { effort: "minimal" },
    max_tokens: 500,
  };
}

async function identify(title: string, author: string | null, callNumber: string | null) {
  try {
    return await openrouter("/chat/completions", payload(title, author, callNumber, true));
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    if (!message.includes("400")) throw err;
    const grounded = await openrouter("/chat/completions", {
      model: MODELS.enrich,
      messages: [
        { role: "system", content: rules },
        { role: "user", content: `Title: ${title}\nAuthor: ${author ?? "unknown"}\nCall number: ${callNumber ?? "none"}` },
      ],
      tools: payload(title, author, callNumber, true).tools,
      reasoning: { effort: "minimal" },
      max_tokens: 500,
    });
    const notes = grounded?.choices?.[0]?.message?.content ?? "";
    return openrouter("/chat/completions", {
      ...payload(title, author, callNumber, false),
      messages: [
        { role: "system", content: rules },
        { role: "user", content: `Title: ${title}\nAuthor: ${author ?? "unknown"}\nNotes:\n${notes}` },
      ],
    });
  }
}

function parseContent(content: unknown) {
  if (typeof content !== "string") return content;
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  }
}

export async function enrich(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json());
  if (!parsed.success || !capped(parsed.data.title) || (parsed.data.author != null && !capped(parsed.data.author))) {
    return c.text("invalid book", 400);
  }
  const { title, author = null, callNumber = null } = parsed.data;
  const key = bookKey(title, author);
  const hit = lookup.get(key) as CacheRow | undefined;
  if (fresh(hit, MODELS.enrich)) {
    const record = JSON.parse(hit!.record);
    return c.json({ ...record, cached: true, embedding: embeddingFrom(hit!.embedding) });
  }

  const json = await identify(title, author ?? null, callNumber);
  const content = json?.choices?.[0]?.message?.content;
  const factsParse = BookFacts.safeParse(normalizeFacts(parseContent(content)));
  if (!factsParse.success) {
    console.log(JSON.stringify({
      route: "/api/enrich",
      failed: "facts",
      issues: factsParse.error.issues.slice(0, 5),
      content: String(typeof content === "string" ? content : JSON.stringify(content)).slice(0, 600),
    }));
    return c.text("enrichment failed", 502);
  }
  const checked = verify(factsParse.data, json, title);
  const canonical = checked.facts.canonical_title
    ? bookKey(checked.facts.canonical_title, checked.facts.authors[0] ?? null)
    : null;
  const record = { facts: checked.facts, flags: checked.flags };
  const now = Math.floor(Date.now() / 1000);
  const row = {
    canonical_key: canonical,
    record: JSON.stringify(record),
    embedding: null,
    model: MODELS.enrich,
    prompt_version: PROMPT_VERSION,
    fetched_at: now,
  };
  save.run({ key, ...row });
  if (canonical && canonical !== key) save.run({ key: canonical, ...row });
  return c.json({ ...record, cached: false });
}
