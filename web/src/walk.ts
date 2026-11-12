import type { Book, Pin } from "../../shared/types.ts";
import { projectAnchor, type Mat3 } from "./overlay/track.ts";

const origins = new Map<string, number>();

export function resetWalkOrigin(sessionId?: string) {
  if (sessionId) origins.delete(sessionId);
  else origins.clear();
}

export function shelfOrigin(sessionId: string) {
  return origins.get(sessionId) ?? 0;
}

export function noteShelfShift(sessionId: string, shift: number) {
  if (!Number.isFinite(shift) || shift === 0) return shelfOrigin(sessionId);
  const next = shelfOrigin(sessionId) + shift;
  origins.set(sessionId, next);
  return next;
}

// Positive when the camera walks toward the right of the shelf: the old center has moved left in the frame.
export function shelfShift(homography: Mat3, width: number, height: number) {
  const point = projectAnchor(homography, 0.5, 0.5, width, height);
  const shift = 0.5 - point.x;
  return Number.isFinite(shift) ? shift : 0;
}

export function pinFor(book: Book, originX: number): Pin | null {
  const detection = book.detections.find((item) => item.box) ?? book.detections[0];
  if (!detection) return null;
  const local = detection.box ? detection.box.x + detection.box.w / 2 : detection.position;
  const x = originX + local;
  const row = detection.shelfRow;
  if (!Number.isFinite(x) || !Number.isFinite(row)) return null;
  return { x, row };
}
