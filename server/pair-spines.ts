import { TextSpines, type TextSpineInput } from "../shared/schemas.ts";

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
};

const BOX_TAG = /<point_box\b[^>]*>([\s\S]*?)<\/point_box>/gi;
const POINT = /\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/g;

function clamp01(n: number) {
  return Math.min(1, Math.max(0, n));
}

function unit(n: number) {
  return clamp01(Math.abs(n) > 1 ? n / 1000 : n);
}

export function parsePointBoxes(content: string): NormBox[] {
  const boxes: NormBox[] = [];
  for (const match of content.matchAll(BOX_TAG)) {
    const points = [...match[1].matchAll(POINT)].map((hit) => [Number(hit[1]), Number(hit[2])] as const);
    if (points.length < 2) continue;
    const [x1, y1] = points[0];
    const [x2, y2] = points[1];
    boxes.push({
      x: clamp01(Math.min(x1, x2) / 1000),
      y: clamp01(Math.min(y1, y2) / 1000),
      w: clamp01(Math.abs(x2 - x1) / 1000),
      h: clamp01(Math.abs(y2 - y1) / 1000),
    });
  }
  return boxes;
}

export function parseTextSpines(content: string): TextSpineInput[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fenced?.[1]?.trim() ?? trimmed;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("spine schema");
  const parsed = TextSpines.safeParse(JSON.parse(raw.slice(start, end + 1)));
  if (!parsed.success) throw new Error("spine schema");
  return parsed.data.spines.map((spine) => ({ ...spine, cx: unit(spine.cx), cy: unit(spine.cy) }));
}

function center(box: NormBox) {
  return { cx: box.x + box.w / 2, cy: box.y + box.h / 2 };
}

export function pairSpines(texts: TextSpineInput[], boxes: NormBox[], maxDistance = 0.2): PairedSpine[] {
  const usedText = new Set<number>();
  const usedBox = new Set<number>();
  const candidates: Array<{ text: number; box: number; distance: number }> = [];
  boxes.forEach((box, boxIndex) => {
    const point = center(box);
    texts.forEach((text, textIndex) => {
      const distance = Math.hypot(text.cx - point.cx, text.cy - point.cy);
      if (distance <= maxDistance) candidates.push({ text: textIndex, box: boxIndex, distance });
    });
  });
  candidates.sort((a, b) => a.distance - b.distance);

  const matched: PairedSpine[] = [];
  for (const candidate of candidates) {
    if (usedText.has(candidate.text) || usedBox.has(candidate.box)) continue;
    usedText.add(candidate.text);
    usedBox.add(candidate.box);
    const text = texts[candidate.text];
    matched.push({
      shelf_row: text.shelf_row,
      position: text.position,
      spine_text: text.spine_text,
      title: text.title,
      author: text.author,
      legible: text.legible,
      confidence: text.confidence,
      call_number: text.call_number,
      sticker: text.sticker,
      ...boxes[candidate.box],
    });
  }

  const unmatchedText: PairedSpine[] = texts
    .filter((_, index) => !usedText.has(index))
    .map((text) => ({
      shelf_row: text.shelf_row,
      position: text.position,
      spine_text: text.spine_text,
      title: text.title,
      author: text.author,
      legible: text.legible,
      confidence: text.confidence,
      call_number: text.call_number,
      sticker: text.sticker,
    }));

  const rowMax = new Map<number, number>();
  for (const spine of [...matched, ...unmatchedText]) {
    rowMax.set(spine.shelf_row, Math.max(rowMax.get(spine.shelf_row) ?? 0, spine.position));
  }

  const illegible: PairedSpine[] = boxes
    .map((box, index) => ({ box, index }))
    .filter((item) => !usedBox.has(item.index))
    .sort((a, b) => center(a.box).cy - center(b.box).cy || center(a.box).cx - center(b.box).cx)
    .map(({ box }) => {
      const point = center(box);
      let shelfRow = 1;
      if (texts.length > 0) {
        let nearest = texts[0];
        let gap = Infinity;
        for (const text of texts) {
          const next = Math.abs(text.cy - point.cy);
          if (next < gap) {
            gap = next;
            nearest = text;
          }
        }
        shelfRow = gap <= maxDistance ? nearest.shelf_row : Math.max(...texts.map((text) => text.shelf_row)) + 1;
      }
      const position = (rowMax.get(shelfRow) ?? 0) + 1;
      rowMax.set(shelfRow, position);
      return {
        shelf_row: shelfRow,
        position,
        spine_text: "",
        title: "",
        author: null,
        legible: false,
        confidence: 0,
        call_number: null,
        sticker: null,
        ...box,
      };
    });

  return [...matched, ...unmatchedText, ...illegible].sort(
    (a, b) => a.shelf_row - b.shelf_row || a.position - b.position,
  );
}
