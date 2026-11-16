import { createHash } from "node:crypto";
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
    CREATE TABLE IF NOT EXISTS covers (
      isbn       TEXT PRIMARY KEY,
      cover_id   INTEGER,
      fetched_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS embeddings (
      hash       TEXT PRIMARY KEY,
      embedding  BLOB NOT NULL,
      model      TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );
  `);
  const coverColumns = db.prepare("PRAGMA table_info(covers)").all() as { name: string }[];
  if (!coverColumns.some((column) => column.name === "cover_url")) {
    db.exec("ALTER TABLE covers ADD COLUMN cover_url TEXT");
  }
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

// An embedding is fixed by its model and text, so that pair is the key. A client cannot store
// a vector under a key another phone will later read.
export function embeddingHash(model: string, text: string) {
  return createHash("sha256").update(model).update("\n").update(text).digest("hex");
}

const DAY_SECONDS = 24 * 60 * 60;
const COVER_HIT_TTL_SECONDS = 30 * DAY_SECONDS;
const COVER_MISS_TTL_SECONDS = DAY_SECONDS;

/** Deletes rows no reader would treat as fresh, so the volume does not fill with dead entries. */
export function purgeExpired(db: Database.Database, now = Math.floor(Date.now() / 1000)) {
  const removed = db.transaction(() => ({
    books: db.prepare("DELETE FROM books WHERE fetched_at < ?").run(now - TTL_SECONDS).changes,
    quickFacts: db
      .prepare("DELETE FROM quick_facts WHERE fetched_at IS NULL OR fetched_at < ? OR (record = 'null' AND fetched_at < ?)")
      .run(now - QUICK_TTL_SECONDS, now - QUICK_MISS_TTL_SECONDS).changes,
    covers: db
      .prepare("DELETE FROM covers WHERE fetched_at < ? OR (cover_id IS NULL AND cover_url IS NULL AND fetched_at < ?)")
      .run(now - COVER_HIT_TTL_SECONDS, now - COVER_MISS_TTL_SECONDS).changes,
    embeddings: db.prepare("DELETE FROM embeddings WHERE fetched_at < ?").run(now - TTL_SECONDS).changes,
  }))();
  return removed;
}
