import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { get } from "idb-keyval";
import { SPINES_JSON_SCHEMA } from "../shared/schemas.ts";
import type { Book, Detection } from "../shared/types.ts";
import { bookKey, mergeCanonical, mergeOverlaps, norm } from "../web/src/pipeline/dedup.ts";
import { knnGraph } from "../web/src/pipeline/graph.ts";
import { score, topRated, withScores } from "../web/src/pipeline/score.ts";
import { stripCrops, stripPlan, stripsFromCanvas } from "../web/src/pipeline/tiling.ts";
import { renamedKeys, useShelf } from "../web/src/store.ts";
import { isValidIsbn13, normalizeFacts, verify, type ChatResponse } from "../server/verify.ts";

vi.mock("idb-keyval", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined) }));
afterEach(() => {
  vi.unstubAllGlobals();
});

function detection(partial: Partial<Detection> & Pick<Detection, "title" | "strip" | "position">): Detection {
  return {
    shelfRow: 1,
    spineText: partial.title,
    author: "Rowling",
    legible: true,
    confidence: 0.8,
    callNumber: null,
    sticker: null,
    box: null,
    stripCenter: null,
    ...partial,
  };
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

describe("norm and overlap merge", () => {
  it("strips articles and punctuation", () => {
    expect(norm("The Hobbit!")).toBe("hobbit");
  });

  it("does not merge a series that is not in a strip overlap", () => {
    const chamber = detection({ strip: 0, position: 1, title: "Harry Potter and the Chamber of Secrets" });
    const prisoner = detection({ strip: 0, position: 2, title: "Harry Potter and the Prisoner of Azkaban" });
    const merged = mergeOverlaps([[chamber, prisoner]]);
    expect(merged).toHaveLength(2);
    expect(new Set(merged.map((item) => item.title)).size).toBe(2);
  });

  it("merges the same title across an overlap and keeps the sharper reading", () => {
    const left = detection({ strip: 0, position: 8, title: "The Hobbit", confidence: 0.4, author: "Tolkien", box: { x: 0.4, y: 0.1, w: 0.08, h: 0.5 } });
    const right = detection({ strip: 1, position: 1, title: "Hobbit", confidence: 0.9, author: "Tolkien", box: { x: 0.42, y: 0.1, w: 0.08, h: 0.5 } });
    const merged = mergeOverlaps([[left], [right]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.9);
  });

  it("keeps the sharper title and the box farther from the strip edge", () => {
    const edge = detection({
      strip: 0,
      position: 8,
      title: "The Hobbit",
      author: "Tolkien",
      confidence: 0.95,
      stripCenter: 0.05,
      box: { x: 0.02, y: 0.1, w: 0.08, h: 0.5 },
    });
    const interior = detection({
      strip: 1,
      position: 1,
      title: "Hobbit",
      author: "Tolkien",
      confidence: 0.4,
      stripCenter: 0.5,
      box: { x: 0.04, y: 0.1, w: 0.08, h: 0.5 },
    });
    const merged = mergeOverlaps([[edge], [interior]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.95);
    expect(merged[0]?.box).toEqual(interior.box);
  });

  it("keeps two copies of the same title when their boxes do not overlap", () => {
    const left = detection({ strip: 0, position: 8, title: "The Hobbit", box: { x: 0.1, y: 0.1, w: 0.04, h: 0.5 } });
    const right = detection({ strip: 1, position: 1, title: "The Hobbit", box: { x: 0.5, y: 0.1, w: 0.04, h: 0.5 } });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(2);
  });

  it("keeps nearby copies when one oversized box overlaps its neighbor", () => {
    const left = detection({ strip: 0, position: 8, title: "The Hobbit", box: { x: 0.1, y: 0.1, w: 0.1, h: 0.5 } });
    const right = detection({ strip: 1, position: 1, title: "The Hobbit", box: { x: 0.15, y: 0.1, w: 0.3, h: 0.5 } });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(2);
  });

  it("merges a spine cut by the strip edge even when its rows are numbered differently", () => {
    const left = detection({ strip: 0, shelfRow: 1, position: 3, title: "El libro español 1980 II", box: { x: 0.207, y: 0.13, w: 0.172, h: 0.83 } });
    const right = detection({ strip: 1, shelfRow: 2, position: 1, title: "EL LIBRO ESPAÑOL 1980 II", box: { x: 0.31, y: 0.13, w: 0.094, h: 0.83 } });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(1);
  });

  it("treats differently punctuated or cut-off author readings as the same author", () => {
    const left = detection({ strip: 0, position: 3, title: "The Newcomes Vol. I", author: "WM.THACKERA", box: { x: 0.559, y: 0.229, w: 0.13, h: 0.771 } });
    const right = detection({ strip: 1, position: 1, title: "THE NEWCOMES VOL.I.", author: "W. M. THACKERAY", box: { x: 0.621, y: 0.22, w: 0.108, h: 0.774 } });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(1);
  });

  it("merges the two halves of a spine cut by the seam between strips", () => {
    const left = detection({ strip: 0, position: 3, title: "Little Women", box: { x: 0.26, y: 0.1, w: 0.283, h: 0.8 }, stripSpan: [0.47, 0.99] });
    const right = detection({ strip: 1, position: 1, title: "LITTLE WOMEN", box: { x: 0.451, y: 0.1, w: 0.2, h: 0.8 }, stripSpan: [0, 0.36] });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(1);
    expect(mergeOverlaps([[left], [{ ...right, stripSpan: [0.05, 0.36] }]])).toHaveLength(2);
  });

  it("keeps the left twin's id so its label is not redrawn", () => {
    const left = detection({ id: "left", strip: 0, position: 8, title: "The Hobbit", confidence: 0.4, author: "Tolkien", box: { x: 0.4, y: 0.1, w: 0.08, h: 0.5 } });
    const right = detection({ id: "right", strip: 1, position: 1, title: "Hobbit", confidence: 0.9, author: "Tolkien", box: { x: 0.42, y: 0.1, w: 0.08, h: 0.5 } });
    const [merged] = mergeOverlaps([[left], [right]]);
    expect(merged).toMatchObject({ id: "left", title: "Hobbit", confidence: 0.9 });
  });

  it("keeps the id already on screen when the right strip returned first", () => {
    const left = detection({ id: "left", strip: 0, position: 8, title: "The Hobbit", author: "Tolkien", box: { x: 0.4, y: 0.1, w: 0.08, h: 0.5 } });
    const right = detection({ id: "right", strip: 1, position: 1, title: "Hobbit", author: "Tolkien", box: { x: 0.42, y: 0.1, w: 0.08, h: 0.5 } });
    expect(mergeOverlaps([[], [right]], new Set())[0]?.id).toBe("right");
    expect(mergeOverlaps([[left], [right]], new Set(["right"]))[0]?.id).toBe("right");
    expect(mergeOverlaps([[left], [right]], new Set(["left", "right"]))[0]?.id).toBe("left");
  });

  it("refuses an overlap merge when the authors conflict", () => {
    const left = detection({ strip: 0, position: 8, title: "The Hobbit", author: "Tolkien" });
    const right = detection({ strip: 1, position: 1, title: "The Hobbit", author: "Someone Else" });
    expect(mergeOverlaps([[left], [right]])).toHaveLength(2);
  });
});

describe("canonical merge", () => {
  it("collapses two editions of one work and keeps both detections", () => {
    const first = book({
      key: bookKey("The Hobbit", "Tolkien"),
      canonicalTitle: "The Hobbit",
      authors: ["J.R.R. Tolkien"],
      detections: [detection({ title: "The Hobbit", strip: 0, position: 1 })],
    });
    const second = book({
      key: bookKey("Hobbit", "Tolkien"),
      canonicalTitle: "The Hobbit",
      authors: ["J.R.R. Tolkien"],
      flags: ["possible_mismatch"],
      detections: [detection({ title: "Hobbit", strip: 1, position: 2 })],
    });
    const merged = mergeCanonical([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.detections).toHaveLength(2);
    expect(merged[0]?.flags).toContain("possible_mismatch");
  });
});

describe("score", () => {
  it("ranks a quick Goodreads rating like any other Goodreads rating", () => {
    const quick = book({ key: "quick", status: "queued", avgRating: 4.4, ratingsCount: 90_000, ratingSource: "goodreads" });
    const verified = book({ key: "verified", avgRating: 4.1, ratingsCount: 90_000, ratingSource: "goodreads" });
    expect(topRated(withScores([verified, quick])).goodreads.map((item) => item.key)).toEqual(["quick", "verified"]);
  });

  it("lets a huge rating count beat a tiny perfect average", () => {
    const niche = score(book({ key: "niche", avgRating: 4.8, ratingsCount: 40 }));
    const classic = score(book({ key: "classic", avgRating: 4.3, ratingsCount: 250_000 }));
    expect(niche).toBeCloseTo(3.93, 2);
    expect(classic).toBeCloseTo(4.3, 2);
    expect(niche!).toBeLessThan(classic!);
  });
});

describe("isbn and verify", () => {
  it("accepts a valid isbn-13", () => {
    expect(isValidIsbn13("9780306406157")).toBe(true);
    expect(isValidIsbn13("9780306406158")).toBe(false);
  });

  it("drops a rating whose url is not among the citations", () => {
    const facts = {
      matched: true,
      match_confidence: 0.9,
      canonical_title: "The Hobbit",
      authors: ["Tolkien"],
      first_published_year: 1937,
      primary_genre: "fantasy" as const,
      secondary_genres: [],
      summary: "A burglar joins a quest.",
      avg_rating: 4.3,
      ratings_count: 1000,
      rating_source: "goodreads" as const,
      rating_url: "https://www.goodreads.com/book/show/5907",
      isbn13: "bad",
    };
    const response: ChatResponse = {
      choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { url: "https://example.com/other" } }] } }],
      usage: { server_tool_use_details: { web_search_requests: 1 } },
    };
    const checked = verify(facts, response, "The Hobbit");
    expect(checked.facts.avg_rating).toBeNull();
    expect(checked.facts.isbn13).toBeNull();
    expect(checked.flags).toContain("unverified_rating");
    expect(checked.flags).toContain("bad_isbn");
  });

  it("keeps a cited rating when the search count is in server_tool_use_details", () => {
    const facts = normalizeFacts({
      matched: true, title: "Little Women", author: "Louisa M. Alcott", primary_genre: null,
      secondary_genres: ["historical_fiction", "young_adult", "romance"], summary: "Four sisters grow up.",
      avg_rating: 4.18, ratings_count: 2544745, rating_url: "https://www.goodreads.com/book/show/1934.Little_Women",
    })!;
    const response: ChatResponse = {
      choices: [{ message: { annotations: [{ type: "url_citation", url_citation: { url: "https://www.goodreads.com/book/show/1934.Little_Women" } }] } }],
      usage: { server_tool_use_details: { web_search_requests: 1 } },
    };
    const checked = verify(facts, response, "Little Women");
    expect(checked.facts).toMatchObject({
      canonical_title: "Little Women", authors: ["Louisa M. Alcott"], avg_rating: 4.18, ratings_count: 2544745,
      rating_source: "goodreads", secondary_genres: ["historical_fiction", "young_adult"], first_published_year: null, isbn13: null,
    });
    expect(checked.flags).toEqual([]);
  });

  it("maps the model's loose answer onto every BookFacts field", () => {
    expect(normalizeFacts({ matched: true, title: "The Talisman", author: "Stephen King and Peter Straub", primary_genre: "fantasy",
      secondary_genres: ["fantasy", "not_a_genre", "horror"], avg_rating: 0, ratings_count: 5, rating_url: "https://x.test" }))
      .toMatchObject({ authors: ["Stephen King", "Peter Straub"], secondary_genres: ["horror"], avg_rating: null, ratings_count: null,
        rating_url: null, rating_source: null, match_confidence: 0.8 });
    expect(normalizeFacts("nope")).toBeNull();
  });
});

describe("graph and strips", () => {
  it("builds undirected links and no self-links", () => {
    const books = [
      book({ key: "a", embedding: [1, 0, 0] }),
      book({ key: "b", embedding: [0.9, 0.1, 0] }),
      book({ key: "c", embedding: [0, 1, 0] }),
    ];
    const graph = knnGraph(books, 2);
    expect(graph.links.every((link) => link.source !== link.target)).toBe(true);
    expect(new Set(graph.links.map((link) => link.source + link.target)).size).toBe(graph.links.length);
    for (const link of graph.links) {
      expect(graph.links.filter((other) => other.source === link.target && other.target === link.source)).toHaveLength(0);
    }
  });

  it("cuts camera strips no longer than the long edge and covering the whole frame", () => {
    const landscape = stripCrops(1920, 1080, 0.18, 1600);
    const portrait = stripCrops(1080, 1920, 0.18, 1600);
    expect(landscape).toHaveLength(4);
    expect(portrait).toHaveLength(2);
    for (const [crops, width, height] of [[landscape, 1920, 1080], [portrait, 1080, 1920]] as const) {
      expect(crops[0].sx).toBe(0);
      expect(crops.at(-1)!.sx + crops.at(-1)!.stripW).toBeCloseTo(width);
      for (const crop of crops) {
        expect(Math.max(crop.outW, crop.outH)).toBeLessThanOrEqual(1600);
        expect(crop.outW / crop.outH).toBeCloseTo(crop.stripW / height, 2);
      }
    }
    expect(portrait[0].outH).toBe(1600);
    expect(landscape[0].outH).toBe(1080);
  });

  it("encodes every strip at once as JPEG", async () => {
    const pending: Array<() => void> = [];
    const drawn: number[][] = [];
    class FakeCanvas {
      constructor(public width: number, public height: number) {}
      getContext() {
        return { drawImage: (...args: unknown[]) => drawn.push(args.slice(1) as number[]) };
      }
      convertToBlob(options: { type: string; quality: number }) {
        return new Promise<Blob>((resolve) => pending.push(() => resolve(new Blob([options.type, String(options.quality)]))));
      }
    }
    vi.stubGlobal("OffscreenCanvas", FakeCanvas);
    const done = stripsFromCanvas({ width: 1920, height: 1080 } as unknown as HTMLCanvasElement);
    await Promise.resolve();
    expect(pending).toHaveLength(4);
    pending.forEach((resolve) => resolve());
    const strips = await done;
    expect(strips.map((strip) => strip.sx)).toEqual(stripCrops(1920, 1080).map((crop) => crop.sx));
    expect(strips.every((strip) => strip.imageWidth === 1920 && strip.imageHeight === 1080)).toBe(true);
    expect(await strips[0].blob.text()).toBe("image/jpeg0.8");
    expect(drawn[1]?.slice(0, 4)).toEqual([strips[1].sx, 0, strips[1].stripW, 1080]);
  });

  it("uses three strips for landscape and two for portrait", () => {
    const landscape = stripPlan(4000, 3000);
    const portrait = stripPlan(3000, 4000);
    expect(landscape.count).toBe(3);
    expect(portrait.count).toBe(2);
    expect(landscape.step).toBeCloseTo(landscape.stripW * (1 - landscape.overlap));
    expect(portrait.overlap).toBeGreaterThanOrEqual(0.15);
    expect(portrait.overlap).toBeLessThanOrEqual(0.2);
  });
});

describe("spine schema", () => {
  it("refuses extra fields", () => {
    expect(SPINES_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("session store", () => {
  it("merges a re-read without losing what the lookups patched", () => {
    const store = useShelf.getState();
    const id = store.beginSession(1, "merge-test");
    const reading = (title: string, position: number) => detection({ id: `${id}:0:0:${position}`, strip: 0, position, title, author: "Tolkien" });
    store.setBooksFor(id, [
      book({ key: "hobbit", status: "queued", mark: "A", detections: [reading("The Hobbit", 0)] }),
      book({ key: "gone", status: "queued", mark: "B", detections: [reading("Gone", 1)] }),
    ]);
    store.patchBookFor(id, "hobbit", { status: "done", canonicalTitle: "The Hobbit", avgRating: 4.3, ratingsCount: 10, ratingSource: "goodreads", flags: ["possible_mismatch"] });
    const twin = reading("HOBBIT", 0);
    useShelf.getState().mergeBooksFor(id, [
      book({ key: "hobbit", status: "queued", canonicalTitle: "HOBBIT", mark: "B", detections: [twin] }),
      book({ key: "new", status: "queued", mark: "A", detections: [reading("New", 2)] }),
    ]);
    const books = useShelf.getState().sessions.find((session) => session.id === id)!.books;
    expect(books.map((item) => item.key)).toEqual(["hobbit", "new"]);
    expect(books[0]).toMatchObject({ status: "done", canonicalTitle: "The Hobbit", avgRating: 4.3, ratingsCount: 10, ratingSource: "goodreads", flags: ["possible_mismatch"], mark: "B" });
    expect(books[0]?.detections).toEqual([twin]);
    expect(books[1]?.status).toBe("queued");
  });

  it("carries a quick rating over when a sharper twin renames the book", () => {
    const store = useShelf.getState();
    const id = store.beginSession(1, "rename-test");
    const spine = detection({ id: `${id}:0:0:0`, strip: 0, position: 1, title: "The Hobbit", author: "TOLKIE" });
    store.setBooksFor(id, [book({ key: "hobbit|tolkie", status: "enriching", mark: "A", detections: [spine] })]);
    store.patchBookFor(id, "hobbit|tolkie", { avgRating: 4.3, ratingsCount: 4_600_000, ratingSource: "goodreads" });
    const renamed = [book({ key: "hobbit|tolkien", status: "queued", mark: "A", detections: [{ ...spine, author: "TOLKIEN" }] })];
    expect([...renamedKeys(useShelf.getState().sessions.find((session) => session.id === id)!.books, renamed)]).toEqual([["hobbit|tolkie", "hobbit|tolkien"]]);
    store.mergeBooksFor(id, renamed);
    const books = useShelf.getState().sessions.find((session) => session.id === id)!.books;
    expect(books).toHaveLength(1);
    expect(books[0]).toMatchObject({ key: "hobbit|tolkien", status: "enriching", avgRating: 4.3, ratingsCount: 4_600_000 });
  });

  function resetShelf() {
    useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", tab: "shelf", answer: "", asking: false });
  }

  it("does not stamp a session that was already stored", async () => {
    resetShelf();
    vi.mocked(get).mockResolvedValueOnce({
      sessions: [{ id: "pre", createdAt: "2020-01-01T00:00:00.000Z", photoCount: 1, books: [book({ key: "dune" })] }],
      currentId: "pre",
    });
    await useShelf.getState().hydrate();
    const session = useShelf.getState().sessions.find((item) => item.id === "pre");
    expect(session?.contract).toBeUndefined();
    expect(session?.mode).toBeUndefined();
    expect(Object.hasOwn(session!.books[0]!, "pin")).toBe(false);
    expect(Object.hasOwn(session!.books[0]!, "coverId")).toBe(false);
  });

  it("drops pin and coverId on a pre-milestone session and still saves a rating", () => {
    resetShelf();
    useShelf.setState({
      sessions: [{ id: "old", createdAt: "2020-01-01T00:00:00.000Z", photoCount: 1, books: [] }],
      currentId: null,
    });
    const store = useShelf.getState();
    store.setBooksFor("old", [book({ key: "dune", pin: { x: 10, row: 1 }, coverId: 42 })]);
    let stored = useShelf.getState().sessions.find((session) => session.id === "old")!.books[0]!;
    expect(Object.hasOwn(stored, "pin")).toBe(false);
    expect(Object.hasOwn(stored, "coverId")).toBe(false);
    store.patchBookFor("old", "dune", { avgRating: 4.3 });
    stored = useShelf.getState().sessions.find((session) => session.id === "old")!.books[0]!;
    expect(stored.avgRating).toBe(4.3);
    expect(useShelf.getState().sessions.find((session) => session.id === "old")?.contract).toBeUndefined();
  });

  it("keeps a legal cover id on a still session and drops the pin", () => {
    resetShelf();
    const id = useShelf.getState().beginSession(1, "still-cover");
    useShelf.getState().setBooksFor(id, [book({ key: "dune", pin: { x: 10, row: 1 }, coverId: 42 })]);
    const session = useShelf.getState().sessions.find((item) => item.id === id)!;
    expect(session).toMatchObject({ contract: 1, mode: "still" });
    expect(Object.hasOwn(session.books[0]!, "pin")).toBe(false);
    expect(session.books[0]?.coverId).toBe(42);
  });

  it("keeps the first walk pin, a gap in x, and no coverId key when neither book has one", () => {
    resetShelf();
    const id = useShelf.getState().beginSession(1, "walk-pin", "walk");
    useShelf.getState().setBooksFor(id, [book({ key: "dune", pin: { x: 10, row: 1, extra: true } as Book["pin"] })]);
    useShelf.getState().mergeBooksFor(id, [book({ key: "dune", pin: { x: 99, row: 2 } }), book({ key: "neuromancer", pin: { x: 40, row: 1 } })]);
    const books = useShelf.getState().sessions.find((session) => session.id === id)!.books;
    expect(books.find((item) => item.key === "dune")?.pin).toEqual({ x: 10, row: 1 });
    expect(books.find((item) => item.key === "neuromancer")?.pin).toEqual({ x: 40, row: 1 });
    expect(Object.hasOwn(books[0]!, "coverId")).toBe(false);
    expect(Object.hasOwn(books[1]!, "coverId")).toBe(false);
  });

  it("omits a cover id that is not null or a positive integer and keeps an explicit null", () => {
    resetShelf();
    const id = useShelf.getState().beginSession(1, "cover-guard", "walk");
    useShelf.getState().setBooksFor(id, [
      book({ key: "zero", coverId: 0 }),
      book({ key: "fraction", coverId: 1.5 }),
      book({ key: "url", coverId: "https://example.test/cover.jpg" as unknown as number }),
      book({ key: "miss", coverId: null }),
    ]);
    const books = useShelf.getState().sessions.find((session) => session.id === id)!.books;
    expect(Object.hasOwn(books.find((item) => item.key === "zero")!, "coverId")).toBe(false);
    expect(Object.hasOwn(books.find((item) => item.key === "fraction")!, "coverId")).toBe(false);
    expect(Object.hasOwn(books.find((item) => item.key === "url")!, "coverId")).toBe(false);
    expect(books.find((item) => item.key === "miss")?.coverId).toBeNull();
  });

  it("does not add the contract to an older session when a new one starts", () => {
    resetShelf();
    useShelf.setState({
      sessions: [{ id: "pre", createdAt: "2020-01-01T00:00:00.000Z", photoCount: 1, books: [] }],
      currentId: null,
    });
    useShelf.getState().beginSession(1, "fresh", "walk");
    expect(useShelf.getState().sessions.find((session) => session.id === "pre")?.contract).toBeUndefined();
    expect(useShelf.getState().sessions.find((session) => session.id === "fresh")).toMatchObject({ contract: 1, mode: "walk" });
  });
});

describe("canonical place", () => {
  it("keeps the earlier pin and an explicit null cover id", () => {
    const first = book({
      key: "a",
      canonicalTitle: "Dune",
      authors: ["Herbert"],
      pin: { x: 10, row: 1 },
      coverId: null,
    });
    const second = book({
      key: "b",
      canonicalTitle: "Dune",
      authors: ["Herbert"],
      pin: { x: 40, row: 2 },
      coverId: 99,
    });
    const merged = mergeCanonical([first, second]);
    expect(merged[0]?.pin).toEqual({ x: 10, row: 1 });
    expect(merged[0]?.coverId).toBeNull();
  });

  it("does not create a coverId key when neither record has one", () => {
    const merged = mergeCanonical([
      book({ key: "a", canonicalTitle: "Dune", authors: ["Herbert"] }),
      book({ key: "b", canonicalTitle: "Dune", authors: ["Herbert"] }),
    ]);
    expect(Object.hasOwn(merged[0]!, "coverId")).toBe(false);
  });
});

describe("scan session mode", () => {
  it("passes still and walk into beginSession and does not mention pin or coverId", () => {
    const source = readFileSync(new URL("../web/src/scan.ts", import.meta.url), "utf8");
    expect(source).toContain('beginSession(files.length, captureId, "still")');
    expect(source).toContain('beginSession(1, captureId, "walk")');
    expect(source).not.toMatch(/\bpin\b/);
    expect(source).not.toMatch(/\bcoverId\b/);
  });
});
