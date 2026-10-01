import type { TextSpineInput } from "../shared/schemas.ts";
import { center, clamp01, keepConsistentOrder, overlap, type NormBox, type PairedSpine } from "./pair-spines.ts";

export type SpineLine = { row: number; box: NormBox; confidence: number; title: string; author: string | null };

const MAX_LINES = 60;

// One spine per line: row|ymin xmin ymax xmax|c|title|author, coordinates 0-1000 (server/prompts/read.md).
export function parseSpineLine(line: string): SpineLine | null {
  const [rowText, boxText, digit, title = "", ...rest] = line.trim().split("|");
  if (boxText === undefined || digit === undefined) return null;
  const row = Number(rowText.trim());
  const coords = boxText.trim().split(/[\s,]+/).map(Number);
  if (!Number.isInteger(row) || row < 1 || coords.length !== 4 || coords.some((n) => !Number.isFinite(n))) return null;
  const [y1, x1, y2, x2] = coords;
  const box = {
    x: clamp01(Math.min(x1, x2) / 1000),
    y: clamp01(Math.min(y1, y2) / 1000),
    w: clamp01(Math.abs(x2 - x1) / 1000),
    h: clamp01(Math.abs(y2 - y1) / 1000),
  };
  if (box.w < 0.005 || box.h < 0.005) return null;
  const c = Number(digit.trim());
  // Join words the spine hyphenates across a line break ("TALIS- MAN").
  const text = title.trim().replace(/(\p{L})-\s+(\p{L})/gu, "$1$2");
  return {
    row,
    box,
    confidence: Number.isInteger(c) && c >= 0 && c <= 9 ? (c + 0.5) / 10 : 0.5,
    title: text === "?" ? "" : text,
    author: rest.join("/").trim() || null,
  };
}

// Stops a model that starts repeating the same spine instead of letting it run to the token cap.
export class LineGuard {
  private kept: NormBox[] = [];
  private repeats = 0;
  stopped = false;

  accept(line: SpineLine) {
    if (this.stopped) return false;
    if (this.kept.some((box) => overlap(box, line.box) > 0.8)) {
      if (++this.repeats >= 3) this.stopped = true;
      return false;
    }
    this.repeats = 0;
    this.kept.push(line.box);
    if (this.kept.length >= MAX_LINES) this.stopped = true;
    return true;
  }
}

export function readLines(text: string): SpineLine[] {
  const guard = new LineGuard();
  const lines: SpineLine[] = [];
  for (const raw of text.split("\n")) {
    const line = parseSpineLine(raw);
    if (line && guard.accept(line)) lines.push(line);
    if (guard.stopped) break;
  }
  return lines;
}

function inside(point: { cx: number; cy: number }, box: NormBox) {
  return point.cx >= box.x && point.cx <= box.x + box.w && point.cy >= box.y && point.cy <= box.y + box.h;
}

// Each line carries its own box. A box that overlaps an earlier one, or sits out of
// left-to-right order in its row, is too uncertain to label.
export function linesToSpines(lines: SpineLine[]): PairedSpine[] {
  const positions = new Map<number, number>();
  const texts: TextSpineInput[] = lines.map((line) => {
    const position = (positions.get(line.row) ?? 0) + 1;
    positions.set(line.row, position);
    const { cx, cy } = center(line.box);
    return {
      shelf_row: line.row,
      position,
      spine_text: [line.title, line.author].filter(Boolean).join(" / "),
      title: line.title,
      author: line.author,
      legible: line.title !== "",
      confidence: line.title ? line.confidence : 0,
      call_number: null,
      sticker: null,
      cx,
      cy,
    };
  });
  const chosen = new Map<number, number>();
  lines.forEach((line, i) => {
    const clash = lines.slice(0, i).some((earlier) => overlap(earlier.box, line.box) > 0.5 || inside(center(line.box), earlier.box));
    if (line.title && !clash) chosen.set(i, i);
  });
  keepConsistentOrder(chosen, texts, lines.map((line) => line.box));
  return texts.map(({ cx: _cx, cy: _cy, ...text }, i) => ({
    ...text,
    placement: !lines[i].title ? "unmatched-box" : chosen.has(i) ? "matched" : "ambiguous",
    ...lines[i].box,
  }));
}
