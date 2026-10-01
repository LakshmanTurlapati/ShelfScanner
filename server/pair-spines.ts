import { TextSpine, type TextSpineInput } from "../shared/schemas.ts";

export type NormBox = { x: number; y: number; w: number; h: number };

export type PairedSpine = {
  shelf_row: number;
  position: number;
  spine_text: string;
  title: string;
  author: string | null;
  legible: boolean;
  confidence: number;
  call_number: string | null;
  sticker: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  placement: "matched" | "unmatched-text" | "unmatched-box" | "ambiguous";
};

const BOX_TAG = /<point_box\b[^>]*>([\s\S]*?)<\/point_box>/gi;
const POINT = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g;

export function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

function unit(n: number) {
  return clamp01(Math.abs(n) > 1 ? n / 1000 : n);
}

export function overlap(a: NormBox, b: NormBox) {
  const w = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const h = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const shared = w * h;
  return shared / (a.w * a.h + b.w * b.h - shared || 1);
}

// A model stuck in a loop repeats the same box, so near-identical boxes are dropped.
export function parsePointBoxes(content: string): NormBox[] {
  const boxes: NormBox[] = [];
  for (const match of content.matchAll(BOX_TAG)) {
    const points = [...match[1].matchAll(POINT)].map((hit) => [Number(hit[1]), Number(hit[2])] as const);
    if (points.length < 2) continue;
    const [x1, y1] = points[0];
    const [x2, y2] = points[1];
    const box = {
      x: clamp01(Math.min(x1, x2) / 1000),
      y: clamp01(Math.min(y1, y2) / 1000),
      w: clamp01(Math.abs(x2 - x1) / 1000),
      h: clamp01(Math.abs(y2 - y1) / 1000),
    };
    if (!boxes.some((kept) => overlap(kept, box) > 0.8)) boxes.push(box);
  }
  return boxes;
}

// Output cut off at the token cap still yields every spine that was complete.
function spineList(raw: string): unknown[] | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let end = raw.lastIndexOf("}");
  for (let tries = 0; end > start && tries < 20; tries++, end = raw.lastIndexOf("}", end - 1)) {
    for (const close of ["", "]}"]) {
      try {
        const spines = JSON.parse(raw.slice(start, end + 1) + close)?.spines;
        if (Array.isArray(spines)) return spines;
      } catch {
        // Try the next closing brace.
      }
    }
  }
  return null;
}

// Without a response schema the model writes null for text it cannot read.
function textSpine(value: unknown) {
  if (!value || typeof value !== "object") return null;
  const spine = value as Record<string, unknown>;
  const parsed = TextSpine.safeParse({
    shelf_row: spine.shelf_row,
    position: spine.position,
    spine_text: spine.spine_text ?? "",
    title: spine.title ?? "",
    author: spine.author ?? null,
    legible: spine.legible,
    confidence: spine.confidence,
    call_number: spine.call_number ?? null,
    sticker: spine.sticker ?? null,
    cx: spine.cx,
    cy: spine.cy,
  });
  return parsed.success ? parsed.data : null;
}

export function parseTextSpines(content: string): TextSpineInput[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const spines = spineList(fenced?.[1]?.trim() ?? trimmed);
  if (!spines) throw new Error("spine schema");
  return spines.flatMap((item) => {
    const spine = textSpine(item);
    return spine ? [{ ...spine, cx: unit(spine.cx), cy: unit(spine.cy) }] : [];
  });
}

export function center(box: NormBox) {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

// Keeps a match only when it sits on every longest left-to-right ordering of its row,
// so one spine on the wrong side drops itself instead of the whole row.
export function keepConsistentOrder(chosen: Map<number, number>, texts: TextSpineInput[], boxes: NormBox[]) {
  const rows = new Map<number, { textIndex: number; cx: number }[]>();
  for (const [textIndex, boxIndex] of chosen) {
    const row = texts[textIndex].shelf_row;
    rows.set(row, [...(rows.get(row) ?? []), { textIndex, cx: center(boxes[boxIndex]).cx }]);
  }
  for (const row of rows.values()) {
    row.sort((a, b) => texts[a.textIndex].position - texts[b.textIndex].position || a.cx - b.cx);
    const before = row.map(() => 1);
    const after = row.map(() => 1);
    for (let j = 0; j < row.length; j++) {
      for (let k = 0; k < j; k++) if (row[k].cx <= row[j].cx) before[j] = Math.max(before[j], before[k] + 1);
    }
    for (let j = row.length - 1; j >= 0; j--) {
      for (let k = j + 1; k < row.length; k++) if (row[j].cx <= row[k].cx) after[j] = Math.max(after[j], after[k] + 1);
    }
    const longest = Math.max(...before);
    const onLongest = row.map((_, j) => before[j] + after[j] - 1 === longest);
    const perDepth = new Map<number, number>();
    row.forEach((_, j) => {
      if (onLongest[j]) perDepth.set(before[j], (perDepth.get(before[j]) ?? 0) + 1);
    });
    row.forEach((item, j) => {
      if (!onLongest[j] || perDepth.get(before[j]) !== 1) chosen.delete(item.textIndex);
    });
  }
}

export function pairSpines(texts: TextSpineInput[], boxes: NormBox[]): PairedSpine[] {
  const rows = new Map<number, number>();
  for (const text of texts) {
    const values = texts.filter((item) => item.shelf_row === text.shelf_row);
    rows.set(text.shelf_row, values.reduce((sum, item) => sum + item.cy, 0) / values.length);
  }
  const boxRows = boxes.map((box) => {
    if (!rows.size) return 1;
    const y = center(box).cy;
    return [...rows].sort((a, b) => Math.abs(a[1] - y) - Math.abs(b[1] - y))[0][0];
  });
  const candidates = texts.map((text) => {
    const near = (xPad: (box: NormBox) => number) => boxes.flatMap((box, index) => {
      if (boxRows[index] !== text.shelf_row) return [];
      const pad = xPad(box);
      const yPad = Math.max(0.025, box.h * 0.15);
      return text.cx >= box.x - pad && text.cx <= box.x + box.w + pad &&
        text.cy >= box.y - yPad && text.cy <= box.y + box.h + yPad ? [index] : [];
    });
    // A box that contains the center outranks a padded neighbor, so a wide spine cannot claim the titles beside it.
    const inside = near(() => 0);
    return inside.length ? inside : near((box) => Math.max(0.012, box.w * 0.35));
  });
  const chosen = new Map<number, number>();
  candidates.forEach((list, textIndex) => {
    if (list.length === 1 && candidates.filter((other) => other.includes(list[0])).length === 1) {
      chosen.set(textIndex, list[0]);
    }
  });
  keepConsistentOrder(chosen, texts, boxes);
  const usedBoxes = new Set(chosen.values());
  const result: PairedSpine[] = texts.map((text, index) => ({
    shelf_row: text.shelf_row,
    position: text.position,
    spine_text: text.spine_text,
    title: text.title,
    author: text.author,
    legible: text.legible,
    confidence: text.confidence,
    call_number: text.call_number,
    sticker: text.sticker,
    placement: chosen.has(index) ? "matched" : candidates[index].length ? "ambiguous" : "unmatched-text",
    ...(chosen.has(index) ? boxes[chosen.get(index)!] : {}),
  }));
  for (const [index, box] of boxes.entries()) {
    if (usedBoxes.has(index)) continue;
    result.push({
      shelf_row: boxRows[index],
      position: boxes.filter((other, otherIndex) => boxRows[otherIndex] === boxRows[index] && center(other).cx <= center(box).cx).length,
      spine_text: "",
      title: "",
      author: null,
      legible: false,
      confidence: 0,
      call_number: null,
      sticker: null,
      placement: "unmatched-box",
      ...box,
    });
  }
  return result.sort((a, b) => a.shelf_row - b.shelf_row ||
    (a.x ?? texts.find((text) => text.shelf_row === a.shelf_row && text.position === a.position)?.cx ?? 1) -
    (b.x ?? texts.find((text) => text.shelf_row === b.shelf_row && text.position === b.position)?.cx ?? 1));
}
