import { describe, expect, it } from "vitest";
import type { Book, Detection } from "../shared/types.ts";
import { assignMarks, layoutCallouts, letterFor, mapStripBox } from "../web/src/overlay/geometry.ts";
import { applyHomography, solveHomography } from "../web/src/overlay/track.ts";

function detection(partial: Partial<Detection> & Pick<Detection, "title" | "strip" | "position">): Detection {
  return {
    shelfRow: 1,
    spineText: partial.title,
    author: null,
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

describe("strip boxes and letters", () => {
  it("maps a strip box back onto the full frame", () => {
    const box = mapStripBox(
      { sx: 100, stripW: 200, imageWidth: 1000, imageHeight: 500 },
      { x: 0.5, y: 0.25, w: 0.1, h: 0.2 },
    );
    expect(box.x).toBeCloseTo(0.2);
    expect(box.y).toBeCloseTo(0.25);
    expect(box.w).toBeCloseTo(0.02);
    expect(box.h).toBeCloseTo(0.2);
  });

  it("keeps letters when scores change", () => {
    const books = [
      book({
        key: "later",
        score: 4.9,
        detections: [detection({ title: "Later", strip: 0, position: 2, box: { x: 0.4, y: 0.2, w: 0.1, h: 0.4 }, stripCenter: 0.45 })],
      }),
      book({
        key: "first",
        score: 1.2,
        detections: [detection({ title: "First", strip: 0, position: 1, box: { x: 0.1, y: 0.2, w: 0.1, h: 0.4 }, stripCenter: 0.15 })],
      }),
    ];
    const marked = assignMarks(books);
    expect(marked.find((item) => item.key === "first")?.mark).toBe("A");
    expect(marked.find((item) => item.key === "later")?.mark).toBe("B");
    expect(letterFor(26)).toBe("AA");
    const rescored = assignMarks(marked.map((item) => ({ ...item, score: item.key === "first" ? 5 : 1 })));
    expect(rescored.map((item) => item.mark)).toEqual(marked.map((item) => item.mark));
  });

  it("stacks gutter badges so two spines do not share a slot", () => {
    const callouts = layoutCallouts([
      { mark: "A", box: { x: 0.1, y: 0.1, w: 0.05, h: 0.2 } },
      { mark: "B", box: { x: 0.2, y: 0.5, w: 0.05, h: 0.2 } },
    ]);
    expect(callouts).toHaveLength(2);
    expect(new Set(callouts.map((callout) => callout.badgeY)).size).toBe(2);
    expect(callouts.every((callout) => callout.side === "left")).toBe(true);
  });
});

describe("homography", () => {
  it("moves a rectangle's corners and its center", () => {
    const src: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 8],
      [0, 8],
    ];
    const dst = src.map(([x, y]) => [x + 4, y * 2 + 1] as [number, number]);
    const homography = solveHomography(src, dst);
    expect(homography).not.toBeNull();
    for (const [x, y] of [...src, [5, 4] as [number, number]]) {
      const point = applyHomography(homography!, x, y);
      expect(point.x).toBeCloseTo(x + 4, 3);
      expect(point.y).toBeCloseTo(y * 2 + 1, 3);
    }
  });
});
