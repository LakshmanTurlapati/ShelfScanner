import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { PROMPT_VERSION } from "../shared/models.ts";

const TTL_SECONDS = 30 * 24 * 60 * 60;

export type CacheRow = {
  key: string;
  record: string;
  embedding: Buffer | null;
  model: string;
  prompt_version: string;
  fetched_at: number;
};

export function openCache(file = process.env.CACHE_PATH ?? "./data/cache.db") {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      key            TEXT PRIMARY KEY,
      canonical_key  TEXT,
      record         TEXT NOT NULL,
      embedding      BLOB,
      model          TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      fetched_at     INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS books_canonical ON books(canonical_key);
    CREATE TABLE IF NOT EXISTS quick_facts (
      key        TEXT PRIMARY KEY,
      record     TEXT,
      fetched_at INTEGER
    );
  `);
  return db;
}

export function fresh(row: CacheRow | undefined, model: string) {
  if (!row) return false;
  if (row.model !== model || row.prompt_version !== PROMPT_VERSION) return false;
  return Math.floor(Date.now() / 1000) - row.fetched_at < TTL_SECONDS;
}

export type QuickRow = { key: string; record: string; fetched_at: number };

const QUICK_TTL_SECONDS = 30 * 24 * 60 * 60;
const QUICK_MISS_TTL_SECONDS = 24 * 60 * 60;

// A book Goodreads did not know is asked about again sooner, in case it has been added since.
export function quickFresh(row: QuickRow | undefined) {
  if (!row) return false;
  const ttl = row.record === "null" ? QUICK_MISS_TTL_SECONDS : QUICK_TTL_SECONDS;
  return Math.floor(Date.now() / 1000) - row.fetched_at < ttl;
}

export function embeddingFrom(blob: Buffer | null) {
  if (!blob) return undefined;
  return Array.from(new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4));
}

export function embeddingTo(values: number[]) {
  return Buffer.from(new Float32Array(values).buffer);
}
