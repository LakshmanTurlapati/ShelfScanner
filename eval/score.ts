import type { NormBox } from "../shared/types.ts";

export type LabeledSpine = { title: string | null; box: NormBox };
export type PredictedSpine = { title: string; box: NormBox | null; placement: string; shown?: boolean };

function normalized(title: string) {
  return title.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function contains(box: NormBox, x: number, y: number) {
  return x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
}

export function scorePredictions(truth: LabeledSpine[], predictions: PredictedSpine[]) {
  const detected = new Set<number>();
  for (const prediction of predictions) {
    if (!prediction.box) continue;
    const x = prediction.box.x + prediction.box.w / 2;
    const y = prediction.box.y + prediction.box.h / 2;
    const index = truth.findIndex((item) => contains(item.box, x, y));
    if (index >= 0) detected.add(index);
  }
  const shown = predictions.filter((item) => item.box && (item.shown ?? (item.placement === "matched" && !!item.title.trim())));
  const covered = new Set<number>();
  let correct = 0;
  let wrongSpineLabels = 0;
  for (const prediction of shown) {
    const box = prediction.box!;
    const x = box.x + box.w / 2;
    const y = box.y + box.h / 2;
    const index = truth.findIndex((item) => contains(item.box, x, y));
    if (index < 0 || covered.has(index) || !truth[index].title || normalized(prediction.title) !== normalized(truth[index].title)) {
      wrongSpineLabels += 1;
      continue;
    }
    covered.add(index);
    correct += 1;
  }
  return {
    truth: truth.length,
    readable: truth.filter((item) => item.title).length,
    detected: detected.size,
    shown: shown.length,
    correct,
    wrongSpineLabels,
    detectionCoverage: truth.length ? detected.size / truth.length : 0,
    recall: truth.some((item) => item.title) ? correct / truth.filter((item) => item.title).length : 0,
    precision: shown.length ? correct / shown.length : 0,
  };
}
