import { describe, expect, it } from "vitest";
import type { Book, Detection } from "../shared/types.ts";
import { anchorsForCapture, labelTitle } from "../web/src/overlay/anchors.ts";
import { assignMarks, layoutCallouts, letterFor, mapStripBox } from "../web/src/overlay/geometry.ts";
import { layoutLiveLabels } from "../web/src/overlay/live-layout.ts";
import { applyHomography, beginTrack, projectAnchor, solveHomography, stepTrack } from "../web/src/overlay/track.ts";

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

describe("live spine anchors", () => {
  it("keeps two physical copies of one book and ignores a prior capture", () => {
    const first = detection({ title: "Hobbit", strip: 0, position: 1, id: "one", captureId: "current", placement: "matched", box: { x: 0.1, y: 0.1, w: 0.04, h: 0.5 } });
    const second = detection({ title: "Hobbit", strip: 0, position: 2, id: "two", captureId: "current", placement: "matched", box: { x: 0.2, y: 0.1, w: 0.04, h: 0.5 } });
    const old = detection({ title: "Hobbit", strip: 0, position: 3, id: "old", captureId: "old", placement: "matched", box: { x: 0.3, y: 0.1, w: 0.04, h: 0.5 } });
    const uncertain = detection({ title: "Hobbit", strip: 0, position: 4, id: "uncertain", captureId: "current", placement: "ambiguous", box: { x: 0.4, y: 0.1, w: 0.04, h: 0.5 } });
    const anchors = anchorsForCapture([book({ key: "hobbit", detections: [first, second, old, uncertain] })], "current");
    expect(anchors.map((anchor) => anchor.id)).toEqual(["one", "two"]);
  });

  it("keeps a possible mismatch on screen but hides its rating", () => {
    const spine = detection({ title: "Hobbit", strip: 0, position: 1, id: "one", captureId: "current", placement: "matched", box: { x: 0.1, y: 0.1, w: 0.04, h: 0.5 } });
    const anchors = anchorsForCapture([book({ key: "hobbit", avgRating: 4.2, flags: ["possible_mismatch"], detections: [spine] })], "current");
    expect(anchors.map((anchor) => [anchor.id, anchor.showRating])).toEqual([["one", false]]);
    expect(anchorsForCapture([book({ key: "hobbit", avgRating: 4.2, detections: [spine] })], "current")[0]?.showRating).toBe(true);
  });

  it("titles a label with the lookup only when it agrees with the spine", () => {
    expect(labelTitle(book({ key: "a", canonicalTitle: "The Hobbit, or There and Back Again" }), "HOBBIT OR THERE AND BACK AGAIN")).toBe("The Hobbit, or There and Back Again");
    expect(labelTitle(book({ key: "b", canonicalTitle: "The Silmarillion" }), "The Hobbit")).toBe("The Hobbit");
    expect(labelTitle(book({ key: "c", canonicalTitle: null }), "The Hobbit")).toBe("The Hobbit");
    expect(labelTitle(book({ key: "d", canonicalTitle: "Dune" }), "Children of Dune")).toBe("Children of Dune");
    expect(labelTitle(book({ key: "e", canonicalTitle: "The Art of The Hobbit" }), "The Hobbit")).toBe("The Hobbit");
    expect(labelTitle(book({ key: "f", canonicalTitle: "Dune Messiah" }), "DUNE")).toBe("DUNE");
    expect(labelTitle(book({ key: "g", canonicalTitle: "The Hobbit, or There and Back Again" }), "THE HOBBIT")).toBe("The Hobbit, or There and Back Again");
    expect(labelTitle(book({ key: "h", canonicalTitle: "Little Women (Little Women, #1)" }), "LITTLE WOMEN")).toBe("Little Women (Little Women, #1)");
    expect(labelTitle(book({ key: "i", canonicalTitle: "The Newcomes" }), "THE NEWCOMES VOL. I.")).toBe("The Newcomes");
  });

  it("places nearby labels without overlap inside the visible camera area", () => {
    const labels = layoutLiveLabels([{ id: "a", x: 130, y: 140 }, { id: "b", x: 135, y: 141 }], 390, 800);
    expect(labels).toHaveLength(2);
    expect(Math.abs(labels[0].labelY - labels[1].labelY)).toBeGreaterThanOrEqual(43);
    expect(labels.every((label) => label.labelY < 800 - 100)).toBe(true);
  });

  it("keeps a placed label in its slot when a new label arrives next to it", () => {
    const [first] = layoutLiveLabels([{ id: "a", x: 130, y: 141 }], 390, 800);
    const crowded = layoutLiveLabels([{ id: "a", x: 130, y: 141 }, { id: "b", x: 135, y: 140 }], 390, 800);
    expect(crowded.find((label) => label.id === "a")?.labelY).not.toBe(first.labelY);
    const sticky = layoutLiveLabels([{ id: "a", x: 130, y: 141 }, { id: "b", x: 135, y: 140 }], 390, 800, 112, new Map([["a", first]]));
    const a = sticky.find((label) => label.id === "a")!;
    const b = sticky.find((label) => label.id === "b")!;
    expect([a.labelX, a.labelY]).toEqual([first.labelX, first.labelY]);
    expect(Math.abs(a.labelY - b.labelY)).toBeGreaterThanOrEqual(43);
  });

  it("moves a sticky label with its spine and re-places it when the slot leaves the view", () => {
    const [first] = layoutLiveLabels([{ id: "a", x: 130, y: 300 }], 390, 800);
    const [moved] = layoutLiveLabels([{ id: "a", x: 140, y: 320 }], 390, 800, 112, new Map([["a", first]]));
    expect([moved.labelX, moved.labelY]).toEqual([first.labelX + 10, first.labelY + 20]);
    const [edge] = layoutLiveLabels([{ id: "a", x: 300, y: 300 }], 390, 800, 112, new Map([["a", first]]));
    expect(edge.labelX + Math.min(164, 390 * 0.42)).toBeLessThanOrEqual(390 - 8);
    expect(edge.leaderX).toBeLessThan(300);
  });

  it("ends the leader on the chip edge nearest its spine", () => {
    const [left, right] = layoutLiveLabels([{ id: "left", x: 60, y: 200 }, { id: "right", x: 350, y: 400 }], 390, 800);
    expect(left.labelX).toBeGreaterThan(60);
    expect(left.leaderX).toBe(left.labelX);
    expect(right.labelX).toBeLessThan(350);
    expect(right.leaderX).toBeCloseTo(right.labelX + 390 * 0.42);
    expect(right.leaderX).toBeLessThan(350);
  });
});

describe("tracking confidence", () => {
  function scene(noise: boolean, seed = 2) {
    const width = 240;
    const height = 180;
    const first = new Float32Array(width * height);
    const random = () => ((seed = Math.imul(seed, 1664525) + 1013904223 | 0) >>> 0) / 4294967296;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let value = noise ? random() : 0;
      if (!noise) for (let i = 0; i < 30; i++) {
        const px = (i * 73 + 19) % width;
        const py = (i * 47 + 11) % height;
        value += Math.exp(-((x - px) ** 2 + (y - py) ** 2) / (2 * (2 + i % 3) ** 2));
      }
      first[y * width + x] = Math.min(1, value);
    }
    const second = new Float32Array(first.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      second[y * width + x] = x >= 6 && y >= 4 ? first[(y - 4) * width + x - 6] : 0;
    }
    return { width, height, first, second };
  }

  it("follows a translated textured frame", () => {
    const { width, height, first, second } = scene(false);
    const { state } = beginTrack({ gray: first, width, height });
    expect(state).not.toBeNull();
    const step = stepTrack(state!, { gray: second, width, height });
    expect(step.steady).toBe(true);
    const point = projectAnchor(step.homography!, 0.5, 0.5, width, height);
    expect(point.x).toBeCloseTo(0.5 + 6 / width, 2);
    expect(point.y).toBeCloseTo(0.5 + 4 / height, 2);
  });

  it("projects an anchor through a mild perspective change", () => {
    const { width, height, first } = scene(false);
    const perspective = 0.00012;
    const warped = new Float32Array(first.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const sourceY = (y - 3) / (1 - perspective * y);
      const sourceX = x * (1 + perspective * sourceY) - 4;
      const sx = Math.round(sourceX);
      const sy = Math.round(sourceY);
      warped[y * width + x] = sx >= 0 && sx < width && sy >= 0 && sy < height ? first[sy * width + sx] : 0;
    }
    const { state } = beginTrack({ gray: first, width, height });
    const step = stepTrack(state!, { gray: warped, width, height });
    expect(step.steady).toBe(true);
    const point = projectAnchor(step.homography!, 0.5, 0.5, width, height);
    expect(point.x).toBeCloseTo((width / 2 + 4) / (1 + perspective * height / 2) / width, 2);
    expect(point.y).toBeCloseTo((height / 2 + 3) / (1 + perspective * height / 2) / height, 2);
  });

  it("never calls independent noise frames steady", () => {
    const { width, height, first } = scene(true);
    const { state } = beginTrack({ gray: first, width, height });
    for (const seed of [3, 4, 5, 6]) {
      expect(stepTrack(state!, { gray: scene(true, seed).first, width, height }).steady).toBe(false);
    }
  });

  it("tracks shifted noise to its true shift", () => {
    const { width, height, first, second } = scene(true);
    const { state } = beginTrack({ gray: first, width, height });
    const step = stepTrack(state!, { gray: second, width, height });
    expect(step.steady).toBe(true);
    const point = applyHomography(step.homography!, width / 2, height / 2);
    expect(point.x).toBeCloseTo(width / 2 + 6, 1);
    expect(point.y).toBeCloseTo(height / 2 + 4, 1);
  });
});
