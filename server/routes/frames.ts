import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Context } from "hono";

export const MAX_FRAMES = 2000;

const file = process.env.FRAMES_DB ?? path.join(path.dirname(process.env.CACHE_PATH ?? "./data/cache.db"), "frames.db");
mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const db = new Database(file);
db.exec(`
  CREATE TABLE IF NOT EXISTS frames (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    capture_id TEXT,
    meta       TEXT NOT NULL,
    image      BLOB NOT NULL
  );
`);
const insert = db.prepare("INSERT INTO frames (created_at, capture_id, meta, image) VALUES (?, ?, ?, ?)");
const trim = db.prepare("DELETE FROM frames WHERE id <= (SELECT id FROM frames ORDER BY id DESC LIMIT 1 OFFSET ?)");

export function trimFrames(max = MAX_FRAMES) {
  trim.run(max);
}

function parseMeta(value: unknown) {
  if (typeof value !== "string") return null;
  try {
    const meta = JSON.parse(value);
    return meta && typeof meta === "object" ? (meta as { captureId?: unknown }) : null;
  } catch {
    return null;
  }
}

export async function saveFrame(c: Context) {
  const body = await c.req.parseBody();
  const meta = parseMeta(body.meta);
  if (!(body.image instanceof File) || !meta) return c.text("invalid frame", 400);
  const image = Buffer.from(await body.image.arrayBuffer());
  if (image[0] !== 0xff || image[1] !== 0xd8) return c.text("invalid frame", 400);
  const captureId = typeof meta.captureId === "string" ? meta.captureId.slice(0, 64) : null;
  insert.run(Date.now(), captureId, JSON.stringify(meta), image);
  trimFrames();
  return c.body(null, 204);
}
