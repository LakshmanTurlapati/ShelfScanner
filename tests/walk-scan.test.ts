import { afterEach, describe, expect, it, vi } from "vitest";
import type { SpineResponse } from "../web/src/api.ts";

vi.mock("idb-keyval", () => ({ get: vi.fn(async () => undefined), set: vi.fn(async () => undefined), del: vi.fn(async () => undefined) }));

const reads = vi.hoisted(() => ({ next: [] as SpineResponse["spines"] }));

vi.mock("../web/src/pipeline/tiling.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/src/pipeline/tiling.ts")>()),
  stripsFromCanvas: vi.fn(async () => [{ blob: new Blob(["strip"]), sx: 0, stripW: 1000, imageWidth: 1000, imageHeight: 600 }]),
}));
vi.mock("../web/src/api.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../web/src/api.ts")>()),
  readStrip: vi.fn(async () => ({ spines: reads.next })),
  quickFacts: vi.fn(async () => ({ items: [] })),
  enrichBook: vi.fn(async () => {
    throw new Error("offline");
  }),
  embedBooks: vi.fn(async () => ({ items: [] })),
}));
vi.mock("../web/src/covers.ts", () => ({ fillCovers: vi.fn(async () => undefined) }));

const { walkOrder } = await import("../web/src/CoverGrid.tsx");
const { scanCanvas } = await import("../web/src/scan.ts");
const { useShelf } = await import("../web/src/store.ts");
const { continueWalk, endWalk, framePlace, startFrame } = await import("../web/src/walk.ts");

const canvas = { width: 1000, height: 600 } as unknown as HTMLCanvasElement;

function spine(title: string, x: number, row = 1): SpineResponse["spines"][number] {
  return { shelf_row: row, position: Math.round(x * 10), spine_text: title, title, author: "Writer", legible: true, confidence: 0.95, call_number: null, sticker: null, x: x - 0.02, y: 0.1, w: 0.04, h: 0.6 };
}

async function read(session: string, frame: string, spines: SpineResponse["spines"]) {
  reads.next = spines;
  return scanCanvas(canvas, { captureId: frame, sessionId: session });
}

const titles = () => walkOrder(useShelf.getState().sessions[0]!.books).map((book) => book.canonicalTitle);

afterEach(() => {
  endWalk();
  useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", tab: "shelf", answer: "", asking: false });
});

describe("walking back along a shelf", () => {
  it("places the read by the titles it shares, so walk order stays true after a reversal", async () => {
    continueWalk("walk");
    startFrame("A", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    const first = await read("walk", "A", [spine("Dune", 0.2), spine("Emma", 0.5), spine("Ulysses", 0.8)]);
    await first.settled;
    // Tracking was lost walking right: the next read is guessed one frame on.
    startFrame("B", { x: 1, rowOffset: 0, section: 1 }, "guess");
    const second = await read("walk", "B", [spine("Hamlet", 0.3), spine("Beloved", 0.6)]);
    // Back at A with tracking lost again, the guess says two frames on; Dune and Emma say otherwise.
    // B's lookups may still be finishing (and re-keying books) while C is read.
    startFrame("C", { x: 2, rowOffset: 0, section: 1 }, "guess");
    const third = await read("walk", "C", [spine("Middlemarch", 0.1), spine("Dune", 0.5), spine("Emma", 0.8)]);
    await Promise.all([second.settled, third.settled]);
    expect(framePlace("C")).toMatchObject({ x: expect.closeTo(-0.3, 5), source: "titles" });
    expect(titles()).toEqual(["Middlemarch", "Dune", "Emma", "Ulysses", "Hamlet", "Beloved"]);
    const books = useShelf.getState().sessions[0]!.books;
    expect(books.find((book) => book.canonicalTitle === "Middlemarch")?.pin).toMatchObject({ x: expect.closeTo(-0.2, 5), frame: "C", section: 1 });
    // A book seen again keeps the place it was first seen at.
    expect(books.find((book) => book.canonicalTitle === "Dune")?.pin).toMatchObject({ x: expect.closeTo(0.2, 5), frame: "A" });
  });

  it("leaves a read where it was guessed when it shares fewer than two titles", async () => {
    continueWalk("walk");
    startFrame("A", { x: 0, rowOffset: 0, section: 1 }, "fixed");
    await (await read("walk", "A", [spine("Dune", 0.2), spine("Emma", 0.5)])).settled;
    startFrame("B", { x: 1, rowOffset: 0, section: 1 }, "guess");
    await (await read("walk", "B", [spine("Dune", 0.4), spine("Hamlet", 0.7)])).settled;
    expect(framePlace("B")).toMatchObject({ x: 1, source: "guess" });
    expect(titles()).toEqual(["Dune", "Emma", "Hamlet"]);
  });
});
