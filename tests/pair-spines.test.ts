import { describe, expect, it } from "vitest";
import type { TextSpineInput } from "../shared/schemas.ts";
import { pairSpines, parsePointBoxes, parseTextSpines, type NormBox } from "../server/pair-spines.ts";

function text(partial: Partial<TextSpineInput> & Pick<TextSpineInput, "title" | "cx" | "cy">): TextSpineInput {
  return {
    shelf_row: 1,
    position: 1,
    spine_text: partial.title,
    author: null,
    legible: true,
    confidence: 0.9,
    call_number: null,
    sticker: null,
    ...partial,
  };
}

describe("point box tags", () => {
  it("reads a 0 to 1000 box as fractions", () => {
    const boxes = parsePointBoxes(
      'note <point_box mention="spine"> (100,200) (300,600) </point_box> tail',
    );
    expect(boxes).toEqual([{ x: 0.1, y: 0.2, w: 0.2, h: 0.4 }]);
  });

  it("reads every spine tag", () => {
    const boxes = parsePointBoxes(
      '<point_box mention="a"> (0,0) (100,100) </point_box><point_box mention="b">(500, 10) (700, 410)</point_box>',
    );
    expect(boxes).toHaveLength(2);
    expect(boxes[1]).toEqual({ x: 0.5, y: 0.01, w: 0.2, h: 0.4 });
  });
});

describe("spine text", () => {
  it("accepts a fenced list and a 0 to 1000 center", () => {
    const spines = parseTextSpines(`\`\`\`json
{"spines":[{"shelf_row":1,"position":2,"spine_text":"Hobbit","title":"Hobbit","author":"Tolkien","legible":true,"confidence":0.8,"call_number":null,"sticker":null,"cx":250,"cy":500}]}
\`\`\``);
    expect(spines[0]?.cx).toBeCloseTo(0.25);
    expect(spines[0]?.cy).toBeCloseTo(0.5);
    expect(spines[0]?.position).toBe(2);
  });
});

describe("nearest center match", () => {
  const left: NormBox = { x: 0.1, y: 0.2, w: 0.1, h: 0.6 };
  const right: NormBox = { x: 0.7, y: 0.2, w: 0.1, h: 0.6 };

  it("keeps the Qwen reading and the Perceptron box", () => {
    const spines = pairSpines(
      [text({ title: "Left", position: 1, cx: 0.16, cy: 0.5 }), text({ title: "Right", position: 2, cx: 0.74, cy: 0.5 })],
      [right, left],
    );
    expect(spines.map((spine) => spine.title)).toEqual(["Left", "Right"]);
    expect(spines[0]).toMatchObject({ x: 0.1, y: 0.2, w: 0.1, h: 0.6, shelf_row: 1, position: 1 });
    expect(spines[1]).toMatchObject({ x: 0.7, position: 2 });
  });

  it("drops a match farther than 0.2 and keeps both leftovers", () => {
    const spines = pairSpines([text({ title: "Far", cx: 0.05, cy: 0.5 })], [right]);
    expect(spines).toHaveLength(2);
    const reading = spines.find((spine) => spine.title === "Far");
    const unread = spines.find((spine) => spine.title === "");
    expect(reading?.x).toBeUndefined();
    expect(unread).toMatchObject({ legible: false, x: 0.7, y: 0.2 });
  });

  it("keeps boxes when the text read fails", () => {
    const spines = pairSpines([], [left, right]);
    expect(spines.map((spine) => [spine.position, spine.x, spine.legible])).toEqual([
      [1, 0.1, false],
      [2, 0.7, false],
    ]);
  });

  it("keeps text when the box read fails", () => {
    const spines = pairSpines([text({ title: "Hobbit", cx: 0.4, cy: 0.5, position: 3, shelf_row: 2 })], []);
    expect(spines).toEqual([
      expect.objectContaining({ title: "Hobbit", shelf_row: 2, position: 3 }),
    ]);
    expect(spines[0]?.x).toBeUndefined();
  });
});
