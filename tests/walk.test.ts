import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book, Detection } from "../shared/types.ts";
import { IDENTITY, type Mat3 } from "../web/src/overlay/track.ts";
import { useShelf } from "../web/src/store.ts";
import { noteShelfShift, resetWalkOrigin, shelfShift } from "../web/src/walk.ts";

vi.mock("idb-keyval", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));

function detection(partial: Partial<Detection> & Pick<Detection, "title" | "strip" | "position">): Detection {
  return {
    shelfRow: 1,
    spineText: partial.title,
    author: "Writer",
    legible: true,
    confidence: 0.9,
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

describe("shelf shift", () => {
  it("measures how far the frame center moved, in widths", () => {
    expect(shelfShift(IDENTITY, 100, 50)).toBe(0);
    const moved: Mat3 = [1, 0, 25, 0, 1, 0, 0, 0, 1];
    expect(shelfShift(moved, 100, 50)).toBeCloseTo(-0.25);
  });
});

describe("walk session", () => {
  afterEach(() => {
    resetWalkOrigin();
    useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", tab: "shelf", answer: "", asking: false });
  });

  it("keeps a book that left the frame and pins the new one at the shifted origin", () => {
    const id = useShelf.getState().beginSession(1, "walk-keep", "walk");
    useShelf.getState().setBooksFor(id, [
      book({
        key: "stayed",
        pin: { x: 0.2, row: 1 },
        detections: [detection({ title: "Stayed", strip: 0, position: 1, shelfRow: 1, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.4 } })],
      }),
    ]);
    noteShelfShift(id, 1.5);
    useShelf.getState().addFrame(id);
    useShelf.getState().mergeBooksFor(id, [
      book({
        key: "next",
        detections: [detection({ title: "Next", strip: 0, position: 1, shelfRow: 2, box: { x: 0.25, y: 0.1, w: 0.1, h: 0.4 } })],
      }),
    ]);
    const session = useShelf.getState().sessions.find((item) => item.id === id)!;
    expect(session.photoCount).toBe(2);
    expect(session.books.map((item) => item.key)).toEqual(["stayed", "next"]);
    expect(session.books[0]?.pin).toEqual({ x: 0.2, row: 1 });
    expect(session.books[1]?.pin).toEqual({ x: 1.8, row: 2 });
  });

  it("does not keep a book that left a still photo", () => {
    const id = useShelf.getState().beginSession(1, "still-drop");
    useShelf.getState().setBooksFor(id, [book({ key: "gone" })]);
    useShelf.getState().mergeBooksFor(id, [book({ key: "kept" })]);
    expect(useShelf.getState().sessions[0]?.books.map((item) => item.key)).toEqual(["kept"]);
  });

  it("asks the camera for Open Shelf and the shelf for a way back", () => {
    const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const camera = readFileSync(new URL("../web/src/CameraScan.tsx", import.meta.url), "utf8");
    expect(app).toContain('live ? "Open Shelf" : "Back to Live View"');
    expect(camera).toContain("noteShelfShift");
    expect(camera).toContain("sessionId");
    expect(camera).not.toContain("replaceRepeatScan");
  });
});
