import { describe, expect, it } from "vitest";
import { SPINES_JSON_SCHEMA } from "../shared/schemas.ts";
import type { Book, Detection } from "../shared/types.ts";
import { bookKey, mergeCanonical, mergeOverlaps, norm } from "../web/src/pipeline/dedup.ts";
import { knnGraph } from "../web/src/pipeline/graph.ts";
import { score } from "../web/src/pipeline/score.ts";
import { stripPlan } from "../web/src/pipeline/tiling.ts";
import { isValidIsbn13, verify, type ChatResponse } from "../server/verify.ts";

function detection(partial: Partial<Detection> & Pick<Detection, "title" | "strip" | "position">): Detection {
  return {
    shelfRow: 1,
    spineText: partial.title,
    author: "Rowling",
    legible: true,
    confidence: 0.8,
    callNumber: null,
    sticker: null,
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
    const left = detection({ strip: 0, position: 8, title: "The Hobbit", confidence: 0.4, author: "Tolkien" });
    const right = detection({ strip: 1, position: 1, title: "Hobbit", confidence: 0.9, author: "Tolkien" });
    const merged = mergeOverlaps([[left], [right]]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.confidence).toBe(0.9);
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
      detections: [detection({ title: "Hobbit", strip: 1, position: 2 })],
    });
    const merged = mergeCanonical([first, second]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.detections).toHaveLength(2);
  });
});

describe("score", () => {
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
      usage: { server_tool_use: { web_search_requests: 1 } },
    };
    const checked = verify(facts, response, "The Hobbit");
    expect(checked.facts.avg_rating).toBeNull();
    expect(checked.facts.isbn13).toBeNull();
    expect(checked.flags).toContain("unverified_rating");
    expect(checked.flags).toContain("bad_isbn");
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
