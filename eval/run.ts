import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { scorePredictions, type LabeledSpine, type PredictedSpine } from "./score.ts";

const dir = path.resolve("eval/golden");
const labeled = readdirSync(dir).filter((name) => name.endsWith(".json"));
if (!labeled.length) {
  console.log("No labeled shelf photos in eval/golden.");
  process.exit(0);
}

let complete = 0;
let truthCount = 0;
let detectedCount = 0;
let readableCount = 0;
let shown = 0;
let correct = 0;
let wrong = 0;
for (const name of labeled) {
  const file = JSON.parse(readFileSync(path.join(dir, name), "utf8")) as {
    image: string;
    truth: LabeledSpine[];
    predictions?: PredictedSpine[];
  };
  if (!existsSync(path.join(dir, file.image))) throw new Error(`${name}: image is missing`);
  if (!Array.isArray(file.truth) || !file.truth.length) throw new Error(`${name}: truth labels are missing`);
  const resultPath = path.resolve("eval/results", name);
  const predictions = existsSync(resultPath)
    ? (JSON.parse(readFileSync(resultPath, "utf8")) as { predictions: PredictedSpine[] }).predictions
    : file.predictions;
  if (!predictions) {
    console.log(`${name}\t${file.truth.length} labeled spines\tpredictions pending`);
    continue;
  }
  const result = scorePredictions(file.truth, predictions);
  complete += 1;
  truthCount += result.truth;
  detectedCount += result.detected;
  readableCount += result.readable;
  shown += result.shown;
  correct += result.correct;
  wrong += result.wrongSpineLabels;
  console.log(`${name}\tdetection coverage ${result.detectionCoverage.toFixed(3)}\ttitle recall ${result.recall.toFixed(3)}\tprecision ${result.precision.toFixed(3)}\twrong-spine labels ${result.wrongSpineLabels}`);
}
if (complete) console.log(`${complete}/${labeled.length} evaluated\t${detectedCount}/${truthCount} spines detected\t${correct}/${readableCount} readable titles shown\t${wrong}/${shown} wrong-spine labels shown`);
else console.log("No model predictions recorded yet; accuracy is unmeasured.");
if (complete !== labeled.length || shown === 0 || wrong > 0) process.exitCode = 1;
