export type LiveTarget = { id: string; x: number; y: number };
export type LiveLabel = LiveTarget & { labelX: number; labelY: number; leaderX: number };
export type LiveSlot = Pick<LiveLabel, "x" | "y" | "labelX" | "labelY">;

export function layoutLiveLabels(
  targets: LiveTarget[],
  width: number,
  height: number,
  bottomInset = 112,
  previous: ReadonlyMap<string, LiveSlot> = new Map(),
): LiveLabel[] {
  const labelW = Math.min(164, Math.max(112, width * 0.42));
  const labelH = 43;
  const top = 64;
  const bottom = height - bottomInset - labelH;
  const placed: LiveLabel[] = [];
  const overlaps = (x: number, y: number) => placed.some((item) => x < item.labelX + labelW + 4 && x + labelW + 4 > item.labelX &&
    y < item.labelY + labelH + 4 && y + labelH + 4 > item.labelY);
  const place = (target: LiveTarget, x: number, y: number) =>
    placed.push({ ...target, labelX: x, labelY: y, leaderX: x < target.x ? x + labelW : x });

  const visible = [...targets]
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .filter((target) => target.x >= 0 && target.x <= width && target.y >= top && target.y <= height - bottomInset);
  const fresh: LiveTarget[] = [];
  // A label already on screen keeps its offset from its spine, so new labels never push it around.
  for (const target of visible) {
    const slot = previous.get(target.id);
    const x = slot ? target.x + slot.labelX - slot.x : 0;
    const y = slot ? target.y + slot.labelY - slot.y : 0;
    if (slot && x >= 8 && x + labelW <= width - 8 && y >= top && y <= bottom && !overlaps(x, y)) place(target, x, y);
    else fresh.push(target);
  }
  for (const target of fresh) {
    const right = target.x + 14;
    const x = right + labelW <= width - 8 ? right : Math.max(8, target.x - labelW - 14);
    const preferred = Math.max(top, Math.min(bottom, target.y - labelH / 2));
    let chosen: number | null = null;
    for (let offset = 0; offset <= 5 && chosen == null; offset++) {
      for (const direction of offset === 0 ? [0] : [1, -1]) {
        const y = preferred + direction * offset * (labelH + 4);
        if (y < top || y > bottom) continue;
        if (!overlaps(x, y)) {
          chosen = y;
          break;
        }
      }
    }
    if (chosen != null) place(target, x, chosen);
  }
  return placed;
}
