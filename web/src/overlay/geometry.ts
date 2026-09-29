import type { Book, NormBox } from "../../../shared/types.ts";

export type StripCrop = {
  sx: number;
  stripW: number;
  imageWidth: number;
  imageHeight: number;
};

export type Callout = {
  mark: string;
  targetX: number;
  targetY: number;
  elbowX: number;
  elbowY: number;
  badgeX: number;
  badgeY: number;
  side: "left" | "right";
};

function clamp(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function mapStripBox(crop: StripCrop, box: NormBox): NormBox {
  const width = Math.max(crop.imageWidth, 1);
  return {
    x: clamp((crop.sx + box.x * crop.stripW) / width),
    y: clamp(box.y),
    w: clamp((box.w * crop.stripW) / width),
    h: clamp(box.h),
  };
}

export function markRank(mark: string) {
  let rank = 0;
  for (const char of mark) rank = rank * 26 + (char.charCodeAt(0) - 64);
  return rank;
}

export function letterFor(index: number) {
  let n = index;
  let label = "";
  while (n >= 0) {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  }
  return label;
}

function reading(book: Book) {
  const detection = [...book.detections].sort(
    (a, b) => a.shelfRow - b.shelfRow || a.position - b.position || (a.box?.x ?? 1) - (b.box?.x ?? 1),
  )[0];
  return {
    row: detection?.shelfRow ?? Number.MAX_SAFE_INTEGER,
    position: detection?.position ?? Number.MAX_SAFE_INTEGER,
    x: detection?.box?.x ?? 1,
  };
}

function anchorBox(book: Book): NormBox | null {
  const placed = book.detections.filter((detection) => detection.box && detection.stripCenter != null);
  if (!placed.length) return book.detections.find((detection) => detection.box)?.box ?? null;
  return placed.reduce((best, detection) =>
    Math.abs(detection.stripCenter! - 0.5) < Math.abs(best.stripCenter! - 0.5) ? detection : best,
  ).box;
}

export function assignMarks(books: Book[]): Book[] {
  const order = books.map((book, index) => ({ book, index, ...reading(book) }));
  order.sort((a, b) => a.row - b.row || a.position - b.position || a.x - b.x || a.book.key.localeCompare(b.book.key));
  const marks = new Map(order.map((item, index) => [item.index, letterFor(index)]));
  return books.map((book, index) => ({
    ...book,
    mark: marks.get(index) ?? letterFor(index),
    box: anchorBox(book),
  }));
}

export function layoutCallouts(items: { mark: string; box: NormBox }[]): Callout[] {
  const placed = items.map((item) => {
    const targetX = item.box.x + item.box.w / 2;
    const targetY = item.box.y + item.box.h / 2;
    const side: "left" | "right" = targetX < 0.5 ? "left" : "right";
    return { mark: item.mark, targetX, targetY, side };
  });
  const out: Callout[] = [];
  for (const side of ["left", "right"] as const) {
    const group = placed.filter((item) => item.side === side).sort((a, b) => a.targetY - b.targetY || a.mark.localeCompare(b.mark));
    const gap = group.length <= 1 ? 0 : Math.min(0.08, 0.72 / group.length);
    group.forEach((item, index) => {
      const badgeY = Math.min(0.92, 0.14 + index * gap);
      const elbowX = side === "left" ? 0.1 : 0.9;
      const badgeX = side === "left" ? 0.045 : 0.955;
      out.push({
        mark: item.mark,
        targetX: item.targetX,
        targetY: item.targetY,
        elbowX,
        elbowY: badgeY,
        badgeX,
        badgeY,
        side,
      });
    });
  }
  return out;
}

export function coverPoint(nx: number, ny: number, containerW: number, containerH: number, frameW: number, frameH: number) {
  const scale = Math.max(containerW / frameW, containerH / frameH);
  const width = frameW * scale;
  const height = frameH * scale;
  return { x: (containerW - width) / 2 + nx * width, y: (containerH - height) / 2 + ny * height };
}
