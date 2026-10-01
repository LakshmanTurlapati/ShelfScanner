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

  it("reads documented annotations nested in a collection", () => {
    const boxes = parsePointBoxes('<collection mention="books" asset_idx="0"><point_box mention="spine"> (10,20) (50,600) </point_box></collection>');
    expect(boxes).toEqual([{ x: 0.01, y: 0.02, w: 0.04, h: 0.58 }]);
  });

  it("drops the repeated boxes of a looping model", () => {
    const tag = (x: number) => `<point_box mention="spine"> (${x},100) (${x + 60},900) </point_box>`;
    const boxes = parsePointBoxes([tag(100), tag(100), tag(102), tag(200), tag(100)].join(""));
    expect(boxes.map((box) => box.x)).toEqual([0.1, 0.2]);
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

  const spine = (position: number, title: string | null) =>
    `{"shelf_row":1,"position":${position},"spine_text":${JSON.stringify(title)},"title":${JSON.stringify(title)},"author":null,"legible":${title !== null},"confidence":0.8,"call_number":null,"sticker":null,"cx":0.5,"cy":0.5}`;

  it("keeps unreadable spines the model marks with null text", () => {
    const spines = parseTextSpines(`{"spines":[${spine(1, "Hobbit")},${spine(2, null)}]}`);
    expect(spines.map((item) => [item.title, item.spine_text])).toEqual([["Hobbit", "Hobbit"], ["", ""]]);
  });

  it("keeps the complete spines of output cut off at the token cap", () => {
    const cut = `\`\`\`json\n{"spines":[${spine(1, "Hobbit")},${spine(2, "Dune")},{"shelf_row":1,"position":3,"spine_te`;
    expect(parseTextSpines(cut).map((item) => item.title)).toEqual(["Hobbit", "Dune"]);
  });

  it("skips a malformed spine instead of the whole strip", () => {
    const spines = parseTextSpines(`{"spines":[${spine(1, "Hobbit")},{"position":"two"}]}`);
    expect(spines.map((item) => item.title)).toEqual(["Hobbit"]);
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

  it("rejects a center that plausibly belongs to two adjacent boxes", () => {
    const spines = pairSpines(
      [text({ title: "Uncertain", cx: 0.2, cy: 0.5 })],
      [{ x: 0.1, y: 0.2, w: 0.1, h: 0.6 }, { x: 0.2, y: 0.2, w: 0.1, h: 0.6 }],
    );
    expect(spines.find((spine) => spine.title === "Uncertain")?.placement).toBe("ambiguous");
    expect(spines.find((spine) => spine.title === "Uncertain")?.x).toBeUndefined();
  });

  it("matches each shelf row without swapping titles across rows", () => {
    const spines = pairSpines(
      [text({ title: "Top", shelf_row: 1, position: 1, cx: 0.5, cy: 0.25 }), text({ title: "Bottom", shelf_row: 2, position: 1, cx: 0.5, cy: 0.75 })],
      [{ x: 0.45, y: 0.6, w: 0.1, h: 0.3 }, { x: 0.45, y: 0.1, w: 0.1, h: 0.3 }],
    );
    expect(spines.filter((spine) => spine.placement === "matched").map((spine) => [spine.title, spine.y])).toEqual([["Top", 0.1], ["Bottom", 0.6]]);
  });

  it("rejects matches that invert the model's left-to-right order", () => {
    const spines = pairSpines(
      [text({ title: "First", position: 1, cx: 0.75, cy: 0.5 }), text({ title: "Second", position: 2, cx: 0.15, cy: 0.5 })],
      [left, right],
    );
    expect(spines.filter((spine) => spine.title).every((spine) => spine.placement === "ambiguous")).toBe(true);
  });

  it("keeps a centered title when a wide neighbor's padding reaches it", () => {
    const shelf: NormBox[] = [
      { x: 0.0, y: 0.14, w: 0.108, h: 0.81 },
      { x: 0.108, y: 0.12, w: 0.105, h: 0.85 },
      { x: 0.213, y: 0.13, w: 0.188, h: 0.83 },
      { x: 0.401, y: 0.13, w: 0.079, h: 0.84 },
      { x: 0.48, y: 0.13, w: 0.188, h: 0.81 },
      { x: 0.668, y: 0.11, w: 0.08, h: 0.85 },
      { x: 0.748, y: 0.11, w: 0.11, h: 0.84 },
      { x: 0.858, y: 0.1, w: 0.103, h: 0.85 },
    ];
    const spines = pairSpines(
      shelf.map((box, index) => text({ title: `T${index + 1}`, position: index + 1, cx: box.x + box.w / 2, cy: box.y + box.h / 2 })),
      shelf,
    );
    expect(spines.map((spine) => [spine.title, spine.placement, spine.x])).toEqual(
      shelf.map((box, index) => [`T${index + 1}`, "matched", box.x]),
    );
  });

  it("drops only the spines that break the row's order", () => {
    const shelf: NormBox[] = Array.from({ length: 8 }, (_, index) => ({ x: 0.02 + index * 0.12, y: 0.1, w: 0.05, h: 0.8 }));
    const centers = shelf.map((box) => box.x + box.w / 2);
    [centers[0], centers[7]] = [centers[7], centers[0]];
    const spines = pairSpines(centers.map((cx, index) => text({ title: `T${index + 1}`, position: index + 1, cx, cy: 0.5 })), shelf);
    const placement = Object.fromEntries(spines.filter((spine) => spine.title).map((spine) => [spine.title, spine.placement]));
    expect(placement).toEqual({
      T1: "ambiguous", T2: "matched", T3: "matched", T4: "matched",
      T5: "matched", T6: "matched", T7: "matched", T8: "ambiguous",
    });
  });
});
