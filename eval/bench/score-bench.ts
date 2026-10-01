import { readFileSync } from "node:fs";
import { token_set_ratio } from "fuzzball";
import type { TextSpineInput } from "../../shared/schemas.ts";
import type { Detection } from "../../shared/types.ts";
import { center, pairSpines, parsePointBoxes, parseTextSpines, type PairedSpine } from "../../server/pair-spines.ts";
import { linesToSpines, readLines } from "../../server/read-lines.ts";
import { mapStripBox } from "../../web/src/overlay/geometry.ts";
import { mergeOverlaps, norm } from "../../web/src/pipeline/dedup.ts";
import { scorePredictions, type LabeledSpine } from "../score.ts";

type Row = {
  config: string;
  variant: string;
  rep: number;
  image: string;
  part: "text" | "boxes" | "lines";
  strip: number;
  status: number;
  firstUnitMs: number | null;
  doneMs: number;
  finish: string | null;
  error: string | null;
  usage: { cost?: number; completion_tokens?: number } | null;
  text: string;
};
type Strip = { sx: number; stripW: number; imageWidth: number; imageHeight: number };
type Image = { name: string; truth: LabeledSpine[]; variants: Record<string, Strip[]> };

const manifest = JSON.parse(readFileSync(".context/bench/manifest.json", "utf8")) as { images: Image[] };
const rows = process.argv.slice(2).flatMap((file) =>
  readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as Row));

function safe<T>(read: () => T[]): T[] {
  try {
    return read();
  } catch {
    return [];
  }
}

function asText(spines: PairedSpine[]): TextSpineInput[] {
  return spines.filter((spine) => spine.x !== undefined).map((spine) => {
    const { cx, cy } = center({ x: spine.x!, y: spine.y!, w: spine.w!, h: spine.h! });
    return { ...spine, cx, cy };
  });
}

const MODES: Record<string, { parts: Row["part"][]; build: (byPart: Partial<Record<Row["part"], string>>) => PairedSpine[] }> = {
  pair: {
    parts: ["text", "boxes"],
    build: (p) => pairSpines(safe(() => parseTextSpines(p.text ?? "")), parsePointBoxes(p.boxes ?? "")),
  },
  gemini: { parts: ["lines"], build: (p) => linesToSpines(readLines(p.lines ?? "")) },
  hybrid: {
    parts: ["lines", "boxes"],
    build: (p) => pairSpines(asText(linesToSpines(readLines(p.lines ?? ""))), parsePointBoxes(p.boxes ?? "")),
  },
};

const pct = (values: number[], q: number) => {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};

const groups = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.config}|${row.rep}|${row.image}`;
  groups.set(key, [...(groups.get(key) ?? []), row]);
}

type Tally = { first: number[]; done: number[]; correct: number; wrong: number; shown: number; readable: number; detected: number; truth: number; lengths: number; errors: number; cost: number; runs: number; wrongRuns: number[] };
const tallies = new Map<string, Tally>();
const CUTOFFS = [5, 6, 7, 8];
const STRICT = process.env.STRICT === "1";

for (const group of groups.values()) {
  const { config, variant, image: name } = group[0];
  const image = manifest.images.find((item) => item.name === name)!;
  const strips = image.variants[variant];
  const present = new Set(group.map((row) => row.part));
  for (const [mode, spec] of Object.entries(MODES)) {
    if (!spec.parts.every((part) => present.has(part))) continue;
    if (mode === "pair" && config !== "BASE") continue;
    const perStrip = strips.map((strip, i) => {
      const byPart = Object.fromEntries(group.filter((row) => row.strip === i).map((row) => [row.part, row.text]));
      return spec.build(byPart).map((spine, k): Detection => {
        const box = spine.x === undefined ? null : mapStripBox(strip, { x: spine.x, y: spine.y!, w: spine.w!, h: spine.h! });
        return {
          id: `${i}:${k}`, placement: spine.placement, strip: i, shelfRow: spine.shelf_row, position: spine.position,
          spineText: spine.spine_text, title: spine.title, author: spine.author, legible: spine.legible, confidence: spine.confidence,
          callNumber: null, sticker: null, box, stripCenter: spine.x === undefined ? null : spine.x + spine.w! / 2, stripSpan: spine.x === undefined ? null : [spine.x, spine.x + spine.w!],
        };
      });
    });
    const merged = mergeOverlaps(perStrip);
    const used = group.filter((row) => spec.parts.includes(row.part));
    const cutoffs = mode === "pair" ? [7] : CUTOFFS;
    for (const c of cutoffs) {
      const gate = (c + 0.5) / 10;
      const predictions = merged.map((d) => ({
        title: d.title, box: d.box, placement: d.placement ?? "matched",
        shown: d.placement === "matched" && d.legible && !!d.title.trim() && d.confidence >= (mode === "pair" ? 0.75 : gate),
      }));
      // Relaxed: a reading that contains the labelled title (e.g. with volume and year) counts as that title.
      const relaxed = predictions.map((p) => {
        if (!p.box || !p.title.trim()) return p;
        const x = p.box.x + p.box.w / 2;
        const y = p.box.y + p.box.h / 2;
        const truth = image.truth.find((t) => x >= t.box.x && x <= t.box.x + t.box.w && y >= t.box.y && y <= t.box.y + t.box.h);
        return truth?.title && token_set_ratio(norm(p.title), norm(truth.title)) >= 90 ? { ...p, title: truth.title } : p;
      });
      const score = scorePredictions(image.truth, STRICT ? predictions : relaxed);
      const key = `${config} ${mode} c>=${c}`;
      const t = tallies.get(key) ?? { first: [], done: [], correct: 0, wrong: 0, shown: 0, readable: 0, detected: 0, truth: 0, lengths: 0, errors: 0, cost: 0, runs: 0, wrongRuns: [] };
      const firsts = used.filter((row) => row.part !== "boxes").map((row) => row.firstUnitMs).filter((ms): ms is number => ms !== null);
      t.first.push(firsts.length ? Math.min(...firsts) : NaN);
      t.done.push(Math.max(...used.map((row) => row.doneMs)));
      t.correct += score.correct;
      t.wrong += score.wrongSpineLabels;
      t.wrongRuns.push(score.wrongSpineLabels);
      t.shown += score.shown;
      t.readable += score.readable;
      t.detected += score.detected;
      t.truth += score.truth;
      t.lengths += used.filter((row) => row.finish === "length").length;
      t.errors += used.filter((row) => row.status !== 200 || row.error).length;
      t.cost += used.reduce((sum, row) => sum + (row.usage?.cost ?? 0), 0);
      t.runs += 1;
      tallies.set(key, t);
    }
  }
}

const table = [...tallies].map(([key, t]) => ({
  key,
  runs: t.runs,
  firstP50: pct(t.first.filter(Number.isFinite), 0.5),
  firstP90: pct(t.first.filter(Number.isFinite), 0.9),
  doneP50: pct(t.done, 0.5),
  doneP90: pct(t.done, 0.9),
  recall: +(t.correct / Math.max(1, t.readable)).toFixed(3),
  precision: +(t.correct / Math.max(1, t.shown)).toFixed(3),
  coverage: +(t.detected / Math.max(1, t.truth)).toFixed(3),
  wrong: t.wrong,
  wrongMedian: pct(t.wrongRuns, 0.5),
  lengths: t.lengths,
  errors: t.errors,
  costPerImage: +(t.cost / t.runs).toFixed(5),
}));
console.table(table);
