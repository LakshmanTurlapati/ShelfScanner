import type { Pin } from "../../shared/types.ts";

export function finitePin(value: unknown): value is Pin {
  if (!value || typeof value !== "object") return false;
  const pin = value as { x?: unknown; row?: unknown };
  return typeof pin.x === "number" && Number.isFinite(pin.x) && typeof pin.row === "number" && Number.isFinite(pin.row);
}

// Only the known fields, and an optional one only when it holds a value: IndexedDB keeps a key
// whose value is undefined, and pins are rebuilt on every merge.
export function clonePin(pin: Pin): Pin {
  const out: Pin = { x: pin.x, row: pin.row };
  if (typeof pin.section === "number" && Number.isInteger(pin.section) && pin.section > 0) out.section = pin.section;
  if (typeof pin.frame === "string" && pin.frame) out.frame = pin.frame;
  return out;
}

export const pinSection = (pin: Pin | null | undefined) => (finitePin(pin) && pin.section ? pin.section : 1);
