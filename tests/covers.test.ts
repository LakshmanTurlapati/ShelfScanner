import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { coverIdFromBooksPayload, resolveCovers } from "../server/covers.ts";
import { openCache } from "../server/cache.ts";
import { coverImageUrl, fillCovers } from "../web/src/covers.ts";
import { useShelf } from "../web/src/store.ts";
import type { Book } from "../shared/types.ts";

vi.mock("idb-keyval", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));

const ISBN = "9780306406157";
const OTHER = "9780547928227";
const file = path.join(mkdtempSync(path.join(tmpdir(), "covers-")), "cache.db");
const db = openCache(file);

function payload(isbn: string, id: number | null) {
  if (id == null) return { [`ISBN:${isbn}`]: { title: "No cover" } };
  return {
    [`ISBN:${isbn}`]: {
      cover: {
        medium: `https://covers.openlibrary.org/b/id/${id}-M.jpg`,
        large: `https://covers.openlibrary.org/b/id/${id}-L.jpg`,
      },
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function book(partial: Partial<Book> & Pick<Book, "key">): Book {
  return {
    detections: [],
    status: "done",
    canonicalTitle: partial.key,
    authors: [],
    firstPublishedYear: null,
    primaryGenre: null,
    secondaryGenres: [],
    summary: null,
    avgRating: null,
    ratingsCount: null,
    ratingSource: null,
    ratingUrl: null,
    isbn13: null,
    flags: [],
    score: null,
    mark: "",
    box: null,
    ...partial,
  };
}

describe("cover id parsing", () => {
  it("reads the Open Library cover id and ignores a record with no cover", () => {
    expect(coverIdFromBooksPayload(payload(ISBN, 8231856), ISBN)).toBe(8231856);
    expect(coverIdFromBooksPayload(payload(ISBN, null), ISBN)).toBeNull();
    expect(coverIdFromBooksPayload({ [`ISBN:${ISBN}`]: { cover: { medium: "https://example.test/cover.jpg" } } }, ISBN)).toBeNull();
  });
});

describe("cover cache", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    db.prepare("DELETE FROM covers").run();
  });

  it("caches a hit and a miss and does not request the JPEG", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).not.toMatch(/\.jpg/);
      expect(decodeURIComponent(new URL(url).searchParams.get("bibkeys") ?? "")).toBe(`ISBN:${ISBN},ISBN:${OTHER}`);
      return jsonResponse({ ...payload(ISBN, 8231856), ...payload(OTHER, null) });
    });
    const first = await resolveCovers(db, [ISBN, `ISBN ${OTHER}`, "9780306406158", ISBN], fetchImpl);
    expect(first).toEqual([
      { isbn: ISBN, coverId: 8231856 },
      { isbn: OTHER, coverId: null },
      { isbn: "9780306406158", coverId: null },
    ]);
    expect(db.prepare("SELECT isbn FROM covers WHERE isbn = ?").get("9780306406158")).toBeUndefined();
    const second = await resolveCovers(db, [ISBN, OTHER], fetchImpl);
    expect(second).toEqual([
      { isbn: ISBN, coverId: 8231856 },
      { isbn: OTHER, coverId: null },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const row = db.prepare("SELECT cover_id FROM covers WHERE isbn = ?").get(OTHER) as { cover_id: number | null };
    expect(row.cover_id).toBeNull();
  });

  it("omits an ISBN when the lookup fails so it can be tried again", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    });
    expect(await resolveCovers(db, [ISBN], fetchImpl)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM covers").get()).toEqual({ n: 0 });
  });

  it("asks again after a miss expires", async () => {
    let now = 1_700_000_000;
    const fetchImpl = vi.fn(async () => jsonResponse(payload(ISBN, null)));
    await resolveCovers(db, [ISBN], fetchImpl, () => now);
    now += 24 * 60 * 60 + 1;
    fetchImpl.mockImplementation(async () => jsonResponse(payload(ISBN, 42)));
    expect(await resolveCovers(db, [ISBN], fetchImpl, () => now)).toEqual([{ isbn: ISBN, coverId: 42 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("covers route", () => {
  let app: Hono;

  beforeAll(async () => {
    process.env.CACHE_PATH = path.join(mkdtempSync(path.join(tmpdir(), "covers-route-")), "cache.db");
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload(ISBN, 8231856))));
    const route = await import("../server/routes/covers.ts");
    app = new Hono().post("/api/covers", route.covers);
  });

  it("returns JSON ids and refuses a body outside the contract", async () => {
    const res = await app.request("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: [ISBN] }),
    });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ items: [{ isbn: ISBN, coverId: 8231856 }] });
    const empty = await app.request("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: [] }),
    });
    expect(empty.status).toBe(400);
  });
});

describe("phone cover ids", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", tab: "shelf", answer: "", asking: false });
  });

  it("stores a cover id, a checked miss, and leaves a failed lookup unset", async () => {
    const id = useShelf.getState().beginSession(1, "covers");
    useShelf.getState().setBooksFor(id, [
      book({ key: "hit", isbn13: ISBN }),
      book({ key: "miss", isbn13: OTHER }),
    ]);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ items: [{ isbn: ISBN, coverId: 11 }, { isbn: OTHER, coverId: null }] })));
    await fillCovers(id);
    const books = useShelf.getState().sessions[0]!.books;
    expect(books.find((item) => item.key === "hit")?.coverId).toBe(11);
    expect(books.find((item) => item.key === "miss")?.coverId).toBeNull();
    expect(coverImageUrl(11)).toBe("https://covers.openlibrary.org/b/id/11-M.jpg");
    expect(coverImageUrl(null)).toBeNull();

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    useShelf.getState().patchBookFor(id, "hit", { coverId: undefined });
    await fillCovers(id);
    expect(Object.hasOwn(useShelf.getState().sessions[0]!.books.find((item) => item.key === "hit")!, "coverId")).toBe(false);
  });

  it("does not look up covers for an unstamped session", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);
    useShelf.setState({
      sessions: [{ id: "old", createdAt: "2020-01-01T00:00:00.000Z", photoCount: 1, books: [book({ key: "old", isbn13: ISBN })] }],
      currentId: "old",
    });
    await fillCovers("old");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(Object.hasOwn(useShelf.getState().sessions[0]!.books[0]!, "coverId")).toBe(false);
  });
});
