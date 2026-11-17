import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Book } from "../shared/types.ts";
import { coverLooksEmpty, coverSrc, noteCoverError, noteCoverMiss } from "../web/src/covers.ts";
import { CoverGrid, walkOrder } from "../web/src/CoverGrid.tsx";

function book(partial: Partial<Book> & Pick<Book, "key">): Book {
  return {
    detections: [],
    status: "done",
    canonicalTitle: partial.key,
    authors: ["Author"],
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

describe("cover grid", () => {
  it("orders a walk by row and then along the shelf, with unpinned books last", () => {
    const books = [
      book({ key: "late", pin: { x: 0.2, row: 2 } }),
      book({ key: "right", pin: { x: 3, row: 1 } }),
      book({ key: "loose" }),
      book({ key: "left", pin: { x: 0.4, row: 1 } }),
    ];
    expect(walkOrder(books).map((item) => item.key)).toEqual(["left", "right", "late", "loose"]);
  });

  it("orders a walk shelf by shelf, and heads each shelf only when there is more than one", () => {
    const books = [
      book({ key: "second-left", pin: { x: 0.1, row: 1, section: 2 } }),
      book({ key: "first-right", pin: { x: 2, row: 1, section: 1 } }),
      book({ key: "first-left", pin: { x: 0.5, row: 1 } }),
      book({ key: "loose" }),
    ];
    expect(walkOrder(books).map((item) => item.key)).toEqual(["first-left", "first-right", "second-left", "loose"]);
    const html = renderToStaticMarkup(createElement(CoverGrid, { books, onOpen: () => undefined }));
    expect(html).toContain(">Shelf 1</h2>");
    expect(html).toContain(">Shelf 2</h2>");
    expect(html).toContain(">Not placed</h2>");
    const single = renderToStaticMarkup(createElement(CoverGrid, { books: books.slice(1, 3), onOpen: () => undefined }));
    expect(single).not.toContain("Shelf 1");
  });

  it("shows an Open Library cover and a title tile for a miss", () => {
    const html = renderToStaticMarkup(createElement(CoverGrid, {
      books: [
        book({ key: "Dune", coverId: 42, pin: { x: 2, row: 1 } }),
        book({ key: "Neuromancer", coverId: null, authors: [], pin: { x: 1, row: 1 } }),
      ],
      onOpen: () => undefined,
    }));
    expect(html.indexOf("Neuromancer")).toBeLessThan(html.indexOf("Dune"));
    expect(html).toContain("https://covers.openlibrary.org/b/id/42-M.jpg");
    expect(html).not.toContain("/api/covers/");
    expect(html).toContain("Author unknown");
    expect(html).toContain("Cover of Neuromancer");
    expect(html).toContain("/logo.svg");
  });

  it("shows the shelf mark when a cover image fails, and retries once before the next source", () => {
    const sources = ["https://covers.openlibrary.org/b/id/42-M.jpg", "https://books.google.com/books/content?id=abc"];
    const retried = noteCoverError(sources, { index: 0, retries: 0, failed: false });
    expect(coverSrc(sources, retried)).toContain("retry=1");
    const next = noteCoverError(sources, retried);
    expect(coverSrc(sources, next)).toBe(sources[1]);
    const failed = noteCoverError(sources, { ...next, retries: 1 });
    expect(coverSrc(sources, failed)).toBeNull();
    expect(coverLooksEmpty({ naturalWidth: 1, naturalHeight: 1 })).toBe(true);
    expect(coverLooksEmpty({ naturalWidth: 180, naturalHeight: 270 })).toBe(false);
    const skipped = noteCoverMiss(sources, { index: 0, retries: 0, failed: false });
    expect(coverSrc(sources, skipped)).toBe(sources[1]);
    const html = renderToStaticMarkup(createElement(CoverGrid, {
      books: [book({ key: "Dune", coverId: null, coverUrl: null })],
      onOpen: () => undefined,
    }));
    expect(html).not.toContain("covers.openlibrary.org");
    expect(html).toContain("/logo.svg");
    expect(html).toContain("Dune");
  });

  it("marks a matching cover without moving it out of walk order", () => {
    const html = renderToStaticMarkup(createElement(CoverGrid, {
      books: [
        book({ key: "Dune", canonicalTitle: "Dune", primaryGenre: "science_fiction", pin: { x: 2, row: 1 } }),
        book({ key: "The Hobbit", canonicalTitle: "The Hobbit", primaryGenre: "fantasy", pin: { x: 1, row: 1 } }),
      ],
      profile: { status: "saved", name: "Ada", genres: ["fantasy"], picks: [] },
      onOpen: () => undefined,
    }));
    expect(html.indexOf("The Hobbit")).toBeLessThan(html.indexOf("Dune"));
    const hobbit = html.slice(html.lastIndexOf("<button", html.indexOf("Cover of The Hobbit")), html.indexOf("Cover of Dune"));
    const dune = html.slice(html.lastIndexOf("<button", html.indexOf("Cover of Dune")));
    expect(hobbit).toContain("For you");
    expect(hobbit).toContain("ring-[#7c3aed]");
    expect(dune).not.toContain("For you");
    expect(dune).not.toContain("ring-[#7c3aed]");
  });
});
