import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MODELS, PROMPT_VERSION } from "../shared/models.ts";
import { cleanTitle, pickRating, quickRating } from "../server/goodreads.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/goodreads-${name}.json`, import.meta.url), "utf8"));

const ANSWERS: Record<string, unknown> = {
  "The Hobbit tolkien": fixture("the-hobbit-tolkien"),
  "The Talisman scott": fixture("the-talisman-scott"),
  "ESMOND thackeray": fixture("esmond-thackeray"),
  "Little Women": fixture("little-women"),
};

function stubGoodreads(answer: (query: string) => Response | Promise<Response> = (query) => Response.json(ANSWERS[query] ?? [])) {
  const fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    return answer(new URL(String(input)).searchParams.get("q") ?? "");
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

function hangingFetch() {
  const fetch = vi.fn((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason))));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Goodreads quick rating", () => {
  it("picks the book itself over a companion book that ranks first", async () => {
    stubGoodreads();
    expect(await quickRating("The Hobbit", "J.R.R. Tolkien")).toEqual({
      matched: true,
      canonical_title: "The Hobbit, or There and Back Again",
      authors: ["J.R.R. Tolkien"],
      avg_rating: 4.3,
      ratings_count: 4641303,
      rating_source: "goodreads",
      rating_url: "https://www.goodreads.com/book/show/5907.The_Hobbit_or_There_and_Back_Again",
    });
  });

  it("requires the spine's author when one is printed", async () => {
    stubGoodreads();
    expect(await quickRating("The Talisman", "Scott")).toMatchObject({ avg_rating: 3.82, ratings_count: 2847, authors: ["Walter Scott"] });
    expect(pickRating(fixture("the-talisman-scott"), "The Talisman", "Stephen King")).toBeNull();
  });

  it("returns nothing for editions without ratings", async () => {
    stubGoodreads();
    expect(await quickRating("Esmond", "Thackeray")).toBeNull();
  });

  it("picks the most-rated match when the spine has no author", async () => {
    stubGoodreads();
    expect(await quickRating("Little Women", null)).toMatchObject({
      canonical_title: "Little Women",
      avg_rating: 4.18,
      ratings_count: 2546791,
      rating_url: "https://www.goodreads.com/book/show/1934.Little_Women",
    });
  });

  it("drops volume markers and sends only the title, surname and a neutral user agent", async () => {
    const fetch = stubGoodreads();
    await quickRating("ESMOND VOL. I", "W.M. Thackeray");
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toBe("https://www.goodreads.com/book/auto_complete?format=json&q=ESMOND%20thackeray");
    expect(init?.headers).toEqual({ "User-Agent": "ShelfScanner/1.0 (+https://shelf-scanner.fly.dev)", Accept: "application/json" });
    expect(["Vol 2 Emma", "Middlemarch Volume III", "Volcano"].map(cleanTitle)).toEqual(["Emma", "Middlemarch", "Volcano"]);
  });

  it("compares surnames, never first names or parts of names", () => {
    const item = (title: string, author: string, avgRating = "4.10", ratingsCount = 5000) =>
      ({ title, bookTitleBare: title, author: { name: author }, avgRating, ratingsCount, bookUrl: `/book/show/${ratingsCount}` });
    const poems = [item("Collected Poems", "Thomas Hardy", "4.10", 9000), item("Collected Poems", "Dylan Thomas", "4.25", 3000)];
    expect(pickRating(poems, "COLLECTED POEMS", "THOMAS")?.authors).toEqual(["Dylan Thomas"]);
    expect(pickRating([item("Lucky Jim", "Kingsley Amis")], "Lucky Jim", "KING")).toBeNull();
    expect(pickRating([item("Painted Bird", "Amos Oz")], "Painted Bird", "Kozinski")).toBeNull();
    expect(pickRating([item("The Talisman", "Stephen King", "4.1", 148000)], "The Talisman", "KING & STRAUB")?.ratings_count).toBe(148000);
    expect(pickRating([item("The Newcomes", "William Makepeace Thackeray", "3.66", 276)], "THE NEWCOMES", "WM.THACKERA")?.avg_rating).toBe(3.66);
  });

  it("matches titles that contain commas", () => {
    const guns = [{ title: "Guns, Germs, and Steel: The Fates of Human Societies", bookTitleBare: "Guns, Germs, and Steel: The Fates of Human Societies",
      author: { name: "Jared Diamond" }, avgRating: "4.05", ratingsCount: 480000, bookUrl: "/book/show/1842.Guns_Germs_and_Steel" }];
    expect(pickRating(guns, "Guns, Germs, and Steel", "JARED DIAMOND")?.ratings_count).toBe(480000);
  });

  it("searches by title alone when study guides crowd out the book", async () => {
    const guide = { title: "Bleak House (Charles Dickens)", bookTitleBare: "Bleak House (Charles Dickens)", author: { name: "Peter Daniel" }, avgRating: "4.00", ratingsCount: 4, bookUrl: "/book/show/456594" };
    const book = { title: "Bleak House", bookTitleBare: "Bleak House", author: { name: "Charles Dickens" }, avgRating: "4.02", ratingsCount: 116944, bookUrl: "/book/show/31242.Bleak_House" };
    const fetch = stubGoodreads((query) => Response.json(query === "Bleak House dickens" ? [guide] : [guide, book]));
    expect(await quickRating("Bleak House", "DICKENS")).toMatchObject({ authors: ["Charles Dickens"], avg_rating: 4.02, ratings_count: 116944 });
    expect(fetch.mock.calls.map(([input]) => new URL(String(input)).searchParams.get("q"))).toEqual(["Bleak House dickens", "Bleak House"]);
  });

  it("matches a title listed after its series name", () => {
    const items = [{ bookTitleBare: "Discworld: Guards! Guards!", avgRating: "4.34", ratingsCount: 190000, author: { name: "Terry Pratchett" }, bookUrl: "/book/show/64216.Guards_Guards_" }];
    expect(pickRating(items, "Guards! Guards!", "Pratchett")).toMatchObject({ avg_rating: 4.34 });
  });

  it("returns null for errors, garbage and timeouts", async () => {
    for (const answer of [
      () => new Response("<html>blocked</html>", { status: 200 }),
      () => new Response("[]", { status: 503 }),
      () => Response.json({ error: "nope" }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      stubGoodreads(answer);
      expect(await quickRating("The Hobbit", "J.R.R. Tolkien")).toBeNull();
    }
    hangingFetch();
    const started = Date.now();
    expect(await quickRating("The Hobbit", "J.R.R. Tolkien")).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps at most 8 requests in flight", async () => {
    let active = 0;
    let peak = 0;
    stubGoodreads(async () => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
      return Response.json([]);
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => quickRating(`Book ${i}`, null)));
    expect(peak).toBe(8);
  });
});

describe("quick facts route", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "quick-")), "cache.db");
  let app: Hono;

  beforeAll(async () => {
    process.env.CACHE_PATH = file;
    const { quickFacts } = await import("../server/routes/quick-facts.ts");
    app = new Hono().post("/api/quick-facts", quickFacts);
    const verified = { facts: { matched: true, canonical_title: "The Hobbit", avg_rating: 4.3 }, flags: ["bad_isbn"] };
    new Database(file).prepare(`INSERT INTO books (key, canonical_key, record, embedding, model, prompt_version, fetched_at)
      VALUES (?, NULL, ?, NULL, ?, ?, ?)`).run("hobbit|j r r tolkien", JSON.stringify(verified), MODELS.enrich, PROMPT_VERSION, Math.floor(Date.now() / 1000));
  });

  const post = (body: unknown) =>
    app.request("/api/quick-facts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const quickRows = () => new Database(file, { readonly: true }).prepare("SELECT key, record FROM quick_facts ORDER BY key").all();

  it("answers from the verified cache, then Goodreads, in request order", async () => {
    const fetch = stubGoodreads();
    const res = await post({ items: [
      { key: "a", title: "The Hobbit", author: "J.R.R. Tolkien" },
      { key: "b", title: "Little Women", author: null },
      { key: "c", title: "Esmond", author: "Thackeray" },
    ] });
    expect(res.status).toBe(200);
    const { items } = await res.json();
    expect(items.map((item: { key: string; verified: boolean }) => [item.key, item.verified])).toEqual([["a", true], ["b", false], ["c", false]]);
    expect(items[0]).toMatchObject({ facts: { canonical_title: "The Hobbit" }, flags: ["bad_isbn"] });
    expect(items[1]).toMatchObject({ facts: { avg_rating: 4.18, rating_source: "goodreads" }, flags: [] });
    expect(items[2]).toEqual({ key: "c", verified: false, facts: null, flags: [] });
    // Little Women, then Esmond with its author and again by title alone.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(quickRows()).toEqual([
      { key: "esmond|thackeray", record: "null" },
      { key: "little women|", record: expect.stringContaining("\"avg_rating\":4.18") },
    ]);

    const again = stubGoodreads();
    const cached = await (await post({ items: [{ key: "b", title: "Little Women", author: null }] })).json();
    expect(cached.items[0]).toMatchObject({ verified: false, facts: { ratings_count: 2546791 } });
    expect(again).not.toHaveBeenCalled();
  });

  it("does not cache failed or late lookups", async () => {
    stubGoodreads(() => new Response("", { status: 429 }));
    const failed = await (await post({ items: [{ key: "x", title: "The Talisman", author: "Scott" }] })).json();
    expect(failed.items).toEqual([{ key: "x", verified: false, facts: null, flags: [] }]);
    hangingFetch();
    const started = Date.now();
    const late = await (await post({ items: [{ key: "y", title: "Dune", author: "Herbert" }] })).json();
    expect(Date.now() - started).toBeLessThan(2500);
    expect(late.items).toEqual([{ key: "y", verified: false, facts: null, flags: [] }]);
    const keys = quickRows().map((row) => (row as { key: string }).key);
    expect(keys).not.toContain("talisman|scott");
    expect(keys).not.toContain("dune|herbert");
  });

  it("rejects bodies outside the contract", async () => {
    const item = { key: "k", title: "T", author: null };
    for (const body of [{ items: [] }, { items: Array(31).fill(item) }, { items: [{ ...item, title: "x".repeat(201) }] }, { items: [{ title: "T" }] }]) {
      expect((await post(body)).status).toBe(400);
    }
  });
});
