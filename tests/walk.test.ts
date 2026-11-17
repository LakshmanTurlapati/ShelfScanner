import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Book, Detection } from "../shared/types.ts";
import { IDENTITY, type Mat3 } from "../web/src/overlay/track.ts";
import { useShelf } from "../web/src/store.ts";
import {
  activeWalk,
  anchorByTitles,
  continueWalk,
  currentWalk,
  endWalk,
  enterSection,
  frameOffset,
  framePlace,
  joinFrames,
  notePosition,
  onFramesMoved,
  onWalkEnd,
  placeFrame,
  shelfShift,
  startFrame,
  startSection,
  WALK_IDLE_MS,
  walkDirection,
  walkPosition,
  walkSection,
} from "../web/src/walk.ts";

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

// A spine read in `frame` at horizontal centre `u` (frame widths) on `row`.
function seen(title: string, frame: string, u: number, row = 1, author = "Writer"): Book {
  return book({
    key: title.toLowerCase(),
    canonicalTitle: title,
    authors: [author],
    detections: [detection({ title, author, strip: 0, position: 1, shelfRow: row, captureId: frame, id: `${frame}:${title}`, box: { x: u - 0.02, y: 0.1, w: 0.04, h: 0.5 } })],
  });
}

afterEach(() => {
  endWalk();
  useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", tab: "shelf", answer: "", asking: false });
});

describe("shelf shift", () => {
  it("measures how far the frame center moved, in widths", () => {
    expect(shelfShift(IDENTITY, 100, 50)).toBe(0);
    const moved: Mat3 = [1, 0, 25, 0, 1, 0, 0, 0, 1];
    expect(shelfShift(moved, 100, 50)).toBeCloseTo(-0.25);
  });

  it("says where a tracked frame starts from its keyframe, in keyframe widths", () => {
    // The keyframe's content moved 25 px left in a 100 px frame: the camera is a quarter frame right.
    const walkedRight: Mat3 = [1, 0, -25, 0, 1, 0, 0, 0, 1];
    expect(frameOffset(walkedRight, 100, 50)).toBeCloseTo(0.25);
    expect(frameOffset(IDENTITY, 100, 50)).toBeCloseTo(0);
  });
});

describe("walk lifecycle", () => {
  it("lasts across calls, ends when idle, and tells listeners", () => {
    const ended = vi.fn();
    const stop = onWalkEnd(ended);
    continueWalk("walk-a", 1000);
    expect(currentWalk(2000)).toBe("walk-a");
    expect(activeWalk()).toBe("walk-a");
    expect(currentWalk(1000 + WALK_IDLE_MS + 1)).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    stop();
  });

  it("numbers New shelf after every section used, and can return to an earlier one", () => {
    continueWalk("walk-b");
    expect(walkSection()).toBe(1);
    expect(startSection()).toBe(2);
    enterSection(1);
    expect(walkSection()).toBe(1);
    expect(startSection()).toBe(3);
  });

  it("turns the walking direction only after a real move", () => {
    continueWalk("walk-c");
    notePosition(1, 1);
    notePosition(1, 1.1);
    expect(walkDirection()).toBe(1);
    notePosition(1, 0.9);
    expect(walkDirection()).toBe(1);
    notePosition(1, 0.7);
    expect(walkDirection()).toBe(-1);
    expect(walkPosition()).toEqual({ section: 1, x: 0.7 });
  });
});

describe("read places", () => {
  it("never lets a guess move a read placed by titles, or titles move the fixed first read", () => {
    continueWalk("walk-d");
    startFrame("a", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    expect(placeFrame("a", { x: 2, rowOffset: 0, section: 1 }, "titles")).toBe(false);
    startFrame("b", { x: 1, rowOffset: 0, section: 1 }, "guess");
    expect(placeFrame("b", { x: -0.6, rowOffset: 1, section: 1 }, "titles")).toBe(true);
    expect(placeFrame("b", { x: 5, rowOffset: 0, section: 1 }, "guess")).toBe(false);
    expect(framePlace("b")).toMatchObject({ x: -0.6, rowOffset: 1, source: "titles" });
  });

  it("moves linked reads together, and the better-placed group decides", () => {
    continueWalk("walk-e");
    startFrame("a", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    startFrame("b", { x: 1, rowOffset: 0, section: 1 }, "guess");
    startFrame("c", { x: 2, rowOffset: 0, section: 1 }, "guess");
    // c was tracked from b, starting 0.4 frames on.
    joinFrames("c", "b", 0.4);
    expect(framePlace("c")!.x).toBeCloseTo(1.4);
    const moved = vi.fn();
    const stop = onFramesMoved(moved);
    // Then b's group was found 0.3 frames right of a: the fixed read decides where they all are.
    joinFrames("b", "a", 0.3);
    stop();
    expect(framePlace("b")!.x).toBeCloseTo(0.3);
    expect(framePlace("c")!.x).toBeCloseTo(0.7);
    expect(framePlace("c")!.source).toBe("fixed");
    expect(moved).toHaveBeenCalledWith(expect.arrayContaining(["b", "c"]), expect.any(Map));
    const before = moved.mock.calls[0]![1] as Map<string, { x: number }>;
    expect(before.get("b")?.x).toBeCloseTo(1);
    expect(before.get("c")?.x).toBeCloseTo(1.4);
  });
});

describe("anchorByTitles", () => {
  const stored = [
    { ...seen("Dune", "a", 0.2), pin: { x: 0.2, row: 1, section: 1, frame: "a" } },
    { ...seen("Emma", "a", 0.5), pin: { x: 0.5, row: 1, section: 1, frame: "a" } },
    { ...seen("Ulysses", "a", 0.8), pin: { x: 0.8, row: 1, section: 1, frame: "a" } },
  ];

  it("places a read from two titles it shares with a placed read", () => {
    // Walking back: Dune and Emma now sit 0.3 frames further right in the new frame.
    const incoming = [seen("Dune", "z", 0.5, 2), seen("Emma", "z", 0.8, 2), seen("New Book", "z", 0.1, 2)];
    expect(anchorByTitles(stored, incoming, "z", 1)).toEqual({ x: expect.closeTo(-0.3, 5), rowOffset: -1 });
  });

  it("needs two that agree, ignores other shelves, and skips a title read twice", () => {
    expect(anchorByTitles(stored, [seen("Dune", "z", 0.5)], "z", 1)).toBeNull();
    expect(anchorByTitles(stored, [seen("Dune", "z", 0.5), seen("Emma", "z", 0.8)], "z", 2)).toBeNull();
    const twice = [seen("Dune", "z", 0.5), { ...seen("Dune", "z", 0.9), key: "dune-2" }, seen("Emma", "z", 0.8)];
    expect(anchorByTitles(stored, twice, "z", 1)).toBeNull();
    // One wrong lookup is outvoted by two that agree.
    const outlier = [seen("Dune", "z", 0.5), seen("Emma", "z", 0.8), seen("Ulysses", "z", 0.1)];
    expect(anchorByTitles(stored, outlier, "z", 1)?.x).toBeCloseTo(-0.3);
  });

  it("does not match a different author's book of the same title", () => {
    const incoming = [seen("Dune", "z", 0.5, 1, "Someone Else Entirely"), seen("Emma", "z", 0.8, 1, "Another Person")];
    expect(anchorByTitles(stored, incoming, "z", 1)).toBeNull();
  });

  it("ignores books pinned by reads already linked into this read's group", () => {
    continueWalk("walk-own");
    startFrame("a", { x: 1, rowOffset: 0, section: 1 }, "guess");
    startFrame("z", { x: 1.3, rowOffset: 0, section: 1 }, "guess");
    joinFrames("z", "a", 0.3);
    const incoming = [seen("Dune", "z", 0.5, 2), seen("Emma", "z", 0.8, 2)];
    expect(anchorByTitles(stored, incoming, "z", 1)).toBeNull();
  });
});

describe("walk session pins", () => {
  it("keeps a book that left the frame and pins the new one from its read's place", () => {
    continueWalk("walk-keep");
    const id = useShelf.getState().beginSession(1, "walk-keep", "walk");
    startFrame("f1", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    useShelf.getState().setBooksFor(id, [seen("Stayed", "f1", 0.2)]);
    startFrame("f2", { x: 1.5, rowOffset: 0, section: 1 }, "guess");
    useShelf.getState().addFrame(id);
    useShelf.getState().mergeBooksFor(id, [seen("Next", "f2", 0.3, 2)]);
    const session = useShelf.getState().sessions.find((item) => item.id === id)!;
    expect(session.photoCount).toBe(2);
    expect(session.books.map((item) => item.key)).toEqual(["stayed", "next"]);
    expect(session.books[0]?.pin).toEqual({ x: 0.2, row: 1, section: 1, frame: "f1" });
    expect(session.books[1]?.pin).toEqual({ x: 1.8, row: 2, section: 1, frame: "f2" });
  });

  it("moves a read's pins when the read is placed better, and only that read's", () => {
    continueWalk("walk-move");
    const id = useShelf.getState().beginSession(1, "walk-move", "walk");
    startFrame("f1", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    useShelf.getState().setBooksFor(id, [seen("First", "f1", 0.2)]);
    startFrame("f2", { x: 1, rowOffset: 0, section: 1 }, "guess");
    useShelf.getState().mergeBooksFor(id, [seen("Second", "f2", 0.5)]);
    placeFrame("f2", { x: -0.4, rowOffset: 0, section: 1 }, "titles");
    const books = useShelf.getState().sessions[0]!.books;
    expect(books.find((item) => item.key === "first")?.pin?.x).toBeCloseTo(0.2);
    expect(books.find((item) => item.key === "second")?.pin?.x).toBeCloseTo(0.1);
  });

  it("moves the pin of a book a later read saw again along with the read that pinned it", () => {
    continueWalk("walk-again");
    const id = useShelf.getState().beginSession(1, "walk-again", "walk");
    startFrame("f1", { x: 1, rowOffset: 0, section: 1 }, "guess");
    useShelf.getState().mergeBooksFor(id, [seen("Dune", "f1", 0.5), seen("Emma", "f1", 0.8)]);
    startFrame("f2", { x: 1.5, rowOffset: 0, section: 1 }, "guess");
    joinFrames("f2", "f1", 0.5);
    // f2 sees Dune again: the stored book now carries only f2's detection, but keeps f1's pin.
    useShelf.getState().mergeBooksFor(id, [seen("Dune", "f2", 0)]);
    placeFrame("f1", { x: 3, rowOffset: 0, section: 1 }, "titles");
    const books = useShelf.getState().sessions.find((item) => item.id === id)!.books;
    expect(books.find((item) => item.key === "dune")?.pin).toMatchObject({ x: expect.closeTo(3.5, 5), frame: "f1" });
    expect(books.find((item) => item.key === "emma")?.pin).toMatchObject({ x: expect.closeTo(3.8, 5), frame: "f1" });
  });

  it("does not keep a book that left a still photo", () => {
    const id = useShelf.getState().beginSession(1, "still-drop");
    useShelf.getState().setBooksFor(id, [book({ key: "gone" })]);
    useShelf.getState().mergeBooksFor(id, [book({ key: "kept" })]);
    expect(useShelf.getState().sessions[0]?.books.map((item) => item.key)).toEqual(["kept"]);
  });

  it("ends the walk when its session is removed or every shelf is cleared", () => {
    continueWalk("walk-gone");
    useShelf.getState().beginSession(1, "walk-gone", "walk");
    useShelf.getState().removeSession("walk-gone");
    expect(activeWalk()).toBeNull();
    continueWalk("walk-clear");
    useShelf.getState().clearLocal();
    expect(activeWalk()).toBeNull();
  });

  it("keeps the live view mounted behind the Shelf and the walk in walk.ts", () => {
    const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    const camera = readFileSync(new URL("../web/src/CameraScan.tsx", import.meta.url), "utf8");
    expect(app).toContain('live ? "Open Shelf" : "Back to Live View"');
    expect(app).toContain("<CameraScan hidden={!live}");
    expect(app).not.toContain("{live && <CameraScan");
    expect(camera).toContain("continueWalk(sessionId)");
    expect(camera).not.toContain("walkSessionId");
  });
});
