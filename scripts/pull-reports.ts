import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const app = readFileSync("fly.toml", "utf8").match(/^app\s*=\s*"([^"]+)"/m)?.[1];
if (!app) throw new Error("fly.toml has no app name");
const local = path.resolve("data/reports.db");

// sftp needs a running machine and refuses to overwrite files.
await fetch(`https://${app}.fly.dev/healthz`);
mkdirSync(path.dirname(local), { recursive: true });
rmSync(local, { force: true });
execFileSync("fly", ["ssh", "sftp", "get", "-a", app, "/data/reports.db", local], { stdio: "inherit" });

const db = new Database(local, { readonly: true });
const rows = db.prepare("SELECT id, created_at, reason, question, answer FROM reports ORDER BY id DESC").all() as Array<{
  id: number;
  created_at: number;
  reason: string;
  question: string;
  answer: string;
}>;
for (const row of rows) {
  console.log(`#${row.id} ${new Date(row.created_at).toISOString()} ${row.reason}`);
  console.log(`Q: ${row.question}`);
  console.log(`A: ${row.answer.replace(/\n/g, "\n   ")}`);
  console.log("");
}
console.log(`${rows.length} reports`);
