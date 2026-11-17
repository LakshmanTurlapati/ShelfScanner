import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book } from "../shared/types.ts";
import { ASK_BOOK_LIMIT, askBooks, askShelf, OfflineError, readStrip } from "../web/src/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function book(key: string, extra: Partial<Book> = {}): Book {
  return {
    key,
    detections: [{ shelfRow: 1, position: 1, strip: 1, spineText: key, title: key, author: null, legible: true, confidence: 0.9, callNumber: null, sticker: null, box: null, stripCenter: null }],
    status: "done",
    canonicalTitle: `The ${key}`,
    authors: ["A. Writer"],
    firstPublishedYear: 1950,
    primaryGenre: "fantasy",
    secondaryGenres: ["horror"],
    summary: "A short summary of the book that a model wrote for the card.",
    avgRating: 4.1,
    ratingsCount: 1200,
    ratingSource: "goodreads",
    ratingUrl: "https://www.goodreads.com/book/show/1",
    isbn13: null,
    flags: [],
    score: 4,
    embedding: Array.from({ length: 1536 }, (_, i) => Math.sin(i) / 10),
    ...extra,
  } as Book;
}

function answer(...parts: string[]) {
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    },
  });
}

describe("ask the shelf", () => {
  it("passes each chunk of the answer through as it arrives", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(answer("The ", "best one."), { status: 200, headers: { "content-type": "text/plain" } })));
    const parts: string[] = [];
    await askShelf("Which book?", [book("hobbit")], (part) => parts.push(part));
    expect(parts.join("")).toBe("The best one.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends only what the server reads, so a long walk stays under the 256 KB limit", async () => {
    const fetch = vi.fn(async () => new Response(answer("ok"), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const shelf = Array.from({ length: 260 }, (_, i) => book(`book-${i}`));
    await askShelf("Which book?", shelf, () => undefined);
    const body = String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body);
    const sent = JSON.parse(body) as { books: Record<string, unknown>[] };
    expect(body).not.toContain("embedding");
    expect(sent.books).toHaveLength(ASK_BOOK_LIMIT);
    expect(new TextEncoder().encode(body).length).toBeLessThan(256 * 1024);
    expect(sent.books[0]).toEqual({
      canonicalTitle: "The book-0",
      detections: [{ title: "book-0" }],
      authors: ["A. Writer"],
      primaryGenre: "fantasy",
      secondaryGenres: ["horror"],
      summary: "A short summary of the book that a model wrote for the card.",
      avgRating: 4.1,
    });
  });

  it("keeps the fields the deployed server's shelfRecords reads", async () => {
    const { shelfRecords } = await import("../server/routes/ask.ts");
    expect(shelfRecords(askBooks([book("hobbit", { canonicalTitle: null })]))).toEqual([
      { title: "hobbit", authors: ["A. Writer"], genres: ["fantasy", "horror"], summary: "A short summary of the book that a model wrote for the card.", rating: 4.1 },
    ]);
  });

  it("stops reading when the ask is cancelled", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException("aborted", "AbortError");
    }));
    await expect(askShelf("Which book?", [book("hobbit")], () => undefined, controller.signal)).rejects.toThrow();
  });

  it("stops before the request when the phone is offline", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await expect(readStrip(new Blob(["x"]), 1, 1)).rejects.toBeInstanceOf(OfflineError);
    expect(fetch).not.toHaveBeenCalled();
    if (online) Object.defineProperty(navigator, "onLine", online);
    else Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
});
