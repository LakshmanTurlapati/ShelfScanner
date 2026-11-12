import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Book } from "../shared/types.ts";
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
  });
});
