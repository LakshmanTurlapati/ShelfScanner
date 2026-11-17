import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MODELS, PROMPT_VERSION } from "../shared/models.ts";
import { resolveCoverQueries } from "../server/covers.ts";
import { embeddingHash, openCache, purgeExpired } from "../server/cache.ts";
import { sweepHits } from "../server/guards.ts";
import { ask } from "../server/routes/ask.ts";
import { readStrip } from "../server/routes/read-strip.ts";

const encoder = new TextEncoder();
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function sse(frames: string[], fail = false) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      if (fail) controller.error(new Error("socket hang up"));
      else controller.close();
    },
  });
}

const delta = (content: string) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

describe("ask stream", () => {
  const app = new Hono().post("/api/ask", ask);

  it("streams a whole answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse([delta("One "), delta("book."), "data: [DONE]\n\n"]))));
    const res = await app.request("/api/ask", json({ question: "Which?", books: [{ canonicalTitle: "The Hobbit" }] }));
    expect(await res.text()).toBe("One book.");
  });

  it("errors the body when the upstream drops, instead of ending a short answer cleanly", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse([delta("One ")], true))));
    const res = await app.request("/api/ask", json({ question: "Which?", books: [] }));
    expect(res.status).toBe(200);
    await expect(res.text()).rejects.toThrow();
  });

  it("errors the body on an upstream error frame", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(sse([delta("One "), `data: ${JSON.stringify({ error: { message: "overloaded" } })}\n\n`]))));
    const res = await app.request("/api/ask", json({ question: "Which?", books: [] }));
    await expect(res.text()).rejects.toThrow();
  });

  it("answers 400 to a body that is not JSON", async () => {
    const res = await app.request("/api/ask", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(res.status).toBe(400);
  });
});

describe("read strip", () => {
  it("rejects a body that is not a JPEG before calling a model", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const app = new Hono().post("/api/read-strip", readStrip);
    const res = await app.request("/api/read-strip?strip=1&of=1", { method: "POST", headers: { "content-type": "image/jpeg" }, body: "hello" });
    expect(res.status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("cache routes", () => {
  let enrichApp: Hono;
  let embedApp: Hono;
  let db: Database.Database;

  beforeAll(async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "release-cache-")), "cache.db");
    process.env.CACHE_PATH = file;
    const { enrich } = await import("../server/routes/enrich.ts");
    const { embed } = await import("../server/routes/embed.ts");
    enrichApp = new Hono().post("/api/enrich", enrich);
    embedApp = new Hono().post("/api/embed", embed);
    db = new Database(file);
  });

  function stubModel(facts: Record<string, unknown>) {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ choices: [{ message: { content: JSON.stringify(facts) } }] })));
  }

  const facts = (canonical: string, extra: Record<string, unknown> = {}) => ({
    matched: true,
    match_confidence: 0.9,
    canonical_title: canonical,
    authors: ["J. R. R. Tolkien"],
    first_published_year: 1937,
    primary_genre: "fantasy",
    secondary_genres: [],
    summary: "A hobbit goes on an adventure.",
    avg_rating: null,
    ratings_count: null,
    rating_source: null,
    rating_url: null,
    isbn13: null,
    ...extra,
  });

  const keys = () => (db.prepare("SELECT key FROM books ORDER BY key").all() as { key: string }[]).map((row) => row.key);

  it("does not store a flagged answer under the title it claims", async () => {
    stubModel(facts("Pride and Prejudice"));
    const res = await enrichApp.request("/api/enrich", json({ title: "The Hobbit", author: null }));
    const body = (await res.json()) as { flags: string[] };
    expect(body.flags).toContain("possible_mismatch");
    expect(keys().some((key) => key.includes("pride"))).toBe(false);
  });

  it("still stores the alias for an answer that agrees with the spine", async () => {
    stubModel(facts("The Hobbit"));
    await enrichApp.request("/api/enrich", json({ title: "The Hobbit or There and Back Again", author: null }));
    expect(keys().filter((key) => key.includes("hobbit")).length).toBeGreaterThanOrEqual(2);
  });

  it("does not fail a lookup over a rating source outside the list", async () => {
    stubModel(facts("Dune", { avg_rating: 4.2, ratings_count: 10, rating_source: "amazon", rating_url: "https://www.amazon.com/dp/1" }));
    const res = await enrichApp.request("/api/enrich", json({ title: "Dune", author: "Frank Herbert" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { facts: { rating_source: string } }).facts.rating_source).toBe("other");
  });

  it("caps the call number and answers 400 to bad JSON", async () => {
    const long = await enrichApp.request("/api/enrich", json({ title: "Dune", callNumber: "x".repeat(101) }));
    expect(long.status).toBe(400);
    const bad = await enrichApp.request("/api/enrich", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("keys embeddings by their text, so one phone cannot plant a vector under another's key", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const input = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      return Response.json({ data: input.map((text, index) => ({ index, embedding: [text.length, 1, 2] })) });
    });
    vi.stubGlobal("fetch", fetch);
    const first = await embedApp.request("/api/embed", json({ items: [{ key: "hobbit", text: "The Hobbit" }] }));
    expect(((await first.json()) as { items: { embedding: number[] }[] }).items[0].embedding).toEqual([10, 1, 2]);
    // Same text under another key is a cache hit.
    const twin = await embedApp.request("/api/embed", json({ items: [{ key: "other", text: "The Hobbit" }] }));
    expect(((await twin.json()) as { items: { key: string }[] }).items[0].key).toBe("other");
    expect(fetch).toHaveBeenCalledTimes(1);
    // Different text under the first key is embedded on its own, not served the planted vector.
    const planted = await embedApp.request("/api/embed", json({ items: [{ key: "hobbit", text: "Something else entirely" }] }));
    expect(((await planted.json()) as { items: { embedding: number[] }[] }).items[0].embedding).toEqual([23, 1, 2]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE hash = ?").get(embeddingHash(MODELS.embed, "The Hobbit"))).toEqual({ n: 1 });
  });
});

describe("cache purge", () => {
  it("deletes rows no reader would treat as fresh", () => {
    const db = openCache(path.join(mkdtempSync(path.join(tmpdir(), "purge-")), "cache.db"));
    const now = 10_000_000;
    const day = 86_400;
    const book = db.prepare("INSERT INTO books (key, canonical_key, record, embedding, model, prompt_version, fetched_at) VALUES (?, NULL, '{}', NULL, ?, ?, ?)");
    book.run("old", MODELS.enrich, PROMPT_VERSION, now - 31 * day);
    book.run("new", MODELS.enrich, PROMPT_VERSION, now - day);
    const quick = db.prepare("INSERT INTO quick_facts (key, record, fetched_at) VALUES (?, ?, ?)");
    quick.run("miss-old", "null", now - 2 * day);
    quick.run("hit", "{}", now - 2 * day);
    const cover = db.prepare("INSERT INTO covers (isbn, cover_id, cover_url, fetched_at) VALUES (?, ?, ?, ?)");
    cover.run("miss-old", null, null, now - 2 * day);
    cover.run("hit", 42, null, now - 2 * day);
    db.prepare("INSERT INTO embeddings (hash, embedding, model, fetched_at) VALUES (?, ?, ?, ?)").run("e", Buffer.alloc(4), MODELS.embed, now - 31 * day);
    expect(purgeExpired(db, now)).toEqual({ books: 1, quickFacts: 1, covers: 1, embeddings: 1 });
    expect(db.prepare("SELECT key FROM books").all()).toEqual([{ key: "new" }]);
  });
});

describe("cover lookups", () => {
  it("looks up a few books at a time", async () => {
    const db = openCache(path.join(mkdtempSync(path.join(tmpdir(), "covers-par-")), "cache.db"));
    let open = 0;
    let most = 0;
    const fetchImpl = vi.fn(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 15));
      open -= 1;
      return Response.json({ docs: [{ cover_i: 7 }] });
    }) as unknown as typeof fetch;
    const lookups = Array.from({ length: 12 }, (_, i) => ({ title: `Book number ${i}`, author: "Writer" }));
    const answers = await resolveCoverQueries(db, lookups, fetchImpl);
    expect(answers).toHaveLength(12);
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(6);
  });

  it("stops waiting at the deadline and leaves the pending books for a later try", async () => {
    const db = openCache(path.join(mkdtempSync(path.join(tmpdir(), "covers-late-")), "cache.db"));
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;
    const started = Date.now();
    const answers = await resolveCoverQueries(db, [{ title: "Slow Book", author: "Writer" }], fetchImpl, undefined, { deadlineMs: 30 });
    expect(answers).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(db.prepare("SELECT COUNT(*) AS n FROM covers").get()).toEqual({ n: 0 });
  });
});

describe("rate limit memory", () => {
  it("forgets addresses with no hit in the last day", () => {
    const now = Date.now();
    const hits = new Map([["idle", [now - 90_000_000]], ["busy", [now - 90_000_000, now - 1000]]]);
    sweepHits(hits, now);
    expect([...hits.keys()]).toEqual(["busy"]);
    expect(hits.get("busy")).toEqual([now - 1000]);
  });
});

describe("answer reports", () => {
  let app: Hono;
  let db: Database.Database;

  beforeAll(async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "reports-")), "reports.db");
    process.env.REPORTS_DB = file;
    const { report } = await import("../server/routes/report.ts");
    app = new Hono().post("/api/report", report);
    db = new Database(file);
  });

  it("stores a report for review", async () => {
    const res = await app.request("/api/report", json({ reason: "offensive", question: "Which?", answer: "A rude answer." }));
    expect(res.status).toBe(204);
    expect(db.prepare("SELECT reason, question, answer FROM reports").all()).toEqual([{ reason: "offensive", question: "Which?", answer: "A rude answer." }]);
  });

  it("rejects an unknown reason, an empty answer, and bad JSON", async () => {
    expect((await app.request("/api/report", json({ reason: "spam", question: "Which?", answer: "x" }))).status).toBe(400);
    expect((await app.request("/api/report", json({ reason: "wrong", question: "Which?", answer: "   " }))).status).toBe(400);
    expect((await app.request("/api/report", { method: "POST", headers: { "content-type": "application/json" }, body: "{" })).status).toBe(400);
  });
});
