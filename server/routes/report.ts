import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { Context } from "hono";
import { z } from "zod";
import { readJson } from "../guards.ts";

// Google Play asks apps that generate content with AI to let people flag it from inside the app.
// A report keeps the question and the answer so they can be reviewed with npm run reports:pull.
export const MAX_REPORTS = 5000;

const file = process.env.REPORTS_DB ?? path.join(path.dirname(process.env.CACHE_PATH ?? "./data/cache.db"), "reports.db");
mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const db = new Database(file);
db.exec(`
  CREATE TABLE IF NOT EXISTS reports (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at INTEGER NOT NULL,
    reason     TEXT NOT NULL,
    question   TEXT NOT NULL,
    answer     TEXT NOT NULL
  );
`);
const insert = db.prepare("INSERT INTO reports (created_at, reason, question, answer) VALUES (?, ?, ?, ?)");
const trim = db.prepare("DELETE FROM reports WHERE id <= (SELECT id FROM reports ORDER BY id DESC LIMIT 1 OFFSET ?)");

const bodySchema = z.object({
  reason: z.enum(["offensive", "wrong"]),
  question: z.string().trim().min(1).max(500),
  answer: z.string().trim().min(1).max(8000),
});

export async function report(c: Context) {
  const parsed = bodySchema.safeParse(await readJson(c));
  if (!parsed.success) return c.text("invalid report", 400);
  const { reason, question, answer } = parsed.data;
  insert.run(Date.now(), reason, question, answer);
  trim.run(MAX_REPORTS);
  return c.body(null, 204);
}
