import { describe, expect, it } from "vitest";
import { scorePredictions } from "../eval/score.ts";

describe("shelf label evaluation", () => {
  it("counts duplicate physical spines separately and penalizes wrong placements", () => {
    const truth = [
      { title: "El libro español", box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
      { title: "El libro español", box: { x: 0.3, y: 0.1, w: 0.1, h: 0.8 } },
    ];
    const result = scorePredictions(truth, [
      { title: "El libro español", placement: "matched", box: { x: 0.11, y: 0.2, w: 0.08, h: 0.5 } },
      { title: "El libro español", placement: "matched", box: { x: 0.12, y: 0.2, w: 0.08, h: 0.5 } },
      { title: "El libro español", placement: "ambiguous", box: { x: 0.3, y: 0.2, w: 0.08, h: 0.5 } },
    ]);
    expect(result).toMatchObject({ correct: 1, wrongSpineLabels: 1, recall: 0.5, precision: 0.5 });
  });

  it("scores only labels the camera actually displays", () => {
    const truth = [{ title: "Hobbit", box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } }];
    const result = scorePredictions(truth, [
      { title: "Wrong", placement: "matched", shown: false, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
      { title: "Hobbit", placement: "matched", shown: true, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
    ]);
    expect(result).toMatchObject({ shown: 1, correct: 1, wrongSpineLabels: 0 });
  });

  it("counts unread spines for detection coverage and rejects a title on them", () => {
    const truth = [
      { title: null, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
      { title: "Hobbit", box: { x: 0.3, y: 0.1, w: 0.1, h: 0.8 } },
    ];
    const result = scorePredictions(truth, [
      { title: "", placement: "unmatched-box", shown: false, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
      { title: "Hobbit", placement: "matched", shown: true, box: { x: 0.3, y: 0.1, w: 0.1, h: 0.8 } },
    ]);
    expect(result).toMatchObject({ detected: 2, detectionCoverage: 1, readable: 1, recall: 1, wrongSpineLabels: 0 });
    const misplaced = scorePredictions(truth, [
      { title: "Hobbit", placement: "matched", shown: true, box: { x: 0.1, y: 0.1, w: 0.1, h: 0.8 } },
    ]);
    expect(misplaced.wrongSpineLabels).toBe(1);
  });
});
