import { describe, expect, it } from "vitest";
import { LineGuard, linesToSpines, parseSpineLine, readLines } from "../server/read-lines.ts";

describe("spine lines", () => {
  it("reads row, box, confidence, title and author", () => {
    expect(parseSpineLine("1|100 200 900 300|8|The Hobbit|J.R.R. Tolkien")).toEqual({
      row: 1,
      box: { x: 0.2, y: 0.1, w: 0.1, h: 0.8 },
      confidence: 0.85,
      title: "The Hobbit",
      author: "J.R.R. Tolkien",
    });
  });

  it("swaps reversed corners and keeps a pipe the model left in the text", () => {
    const line = parseSpineLine("2|900 300 100 200|9|Either/Or|Kierkegaard|extra");
    expect(line?.box).toEqual({ x: 0.2, y: 0.1, w: 0.1, h: 0.8 });
    expect(line?.author).toBe("Kierkegaard/extra");
  });

  it("joins a word hyphenated across a line break", () => {
    expect(parseSpineLine("1|0 0 900 100|9|THE TALIS- MAN|SCOTT")?.title).toBe("THE TALISMAN");
    expect(parseSpineLine("1|0 0 900 100|9|Jekyll-Hyde|")?.title).toBe("Jekyll-Hyde");
  });

  it("treats ? as an unread spine and rejects malformed lines", () => {
    expect(parseSpineLine("1|0 0 900 100|3|?|")).toMatchObject({ title: "", author: null });
    for (const bad of ["```", "row|ymin xmin ymax xmax|c|title|author", "1|1 2 3|9|Short box", "1|0 0 1 900|9|Too thin|", ""]) {
      expect(parseSpineLine(bad)).toBeNull();
    }
  });

  it("ignores a code fence and stops a repeating model", () => {
    const repeat = "1|100 100 900 200|9|Dune|Herbert";
    const text = ["```", "1|100 0 900 90|9|Emma|Austen", repeat, repeat, repeat, repeat, "1|100 300 900 400|9|Never reached|", "```"].join("\n");
    expect(readLines(text).map((line) => line.title)).toEqual(["Emma", "Dune"]);
  });

  it("caps the number of lines", () => {
    const guard = new LineGuard();
    const accepted = Array.from({ length: 80 }, (_, i) => parseSpineLine(`1|0 ${i * 12} 900 ${i * 12 + 10}|9|Book ${i}|`)!)
      .filter((line) => guard.accept(line));
    expect(accepted).toHaveLength(60);
    expect(guard.stopped).toBe(true);
  });

  it("labels clear spines and holds back overlapping or out-of-order ones", () => {
    // When one spine is out of order, both it and the spine it swapped with are held back.
    const spines = linesToSpines(readLines([
      "1|100 0 900 100|9|Left|",
      "1|100 20 900 120|9|Overlaps left|",
      "1|100 500 900 600|9|Right|",
      "1|100 300 900 400|9|Out of order|",
      "1|100 700 900 800|2|?|",
      "2|950 0 990 100|7|Next row|",
    ].join("\n")));
    expect(spines.map((spine) => [spine.title, spine.placement, spine.position])).toEqual([
      ["Left", "matched", 1],
      ["Overlaps left", "ambiguous", 2],
      ["Right", "ambiguous", 3],
      ["Out of order", "ambiguous", 4],
      ["", "unmatched-box", 5],
      ["Next row", "matched", 1],
    ]);
    expect(spines[0]).toMatchObject({ x: 0, y: 0.1, w: 0.1, h: 0.8, confidence: 0.95, legible: true, spine_text: "Left" });
    expect(spines[4]).toMatchObject({ legible: false, confidence: 0 });
  });
});
