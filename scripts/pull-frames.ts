import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const app = readFileSync("fly.toml", "utf8").match(/^app\s*=\s*"([^"]+)"/m)?.[1];
if (!app) throw new Error("fly.toml has no app name");
const local = path.resolve("data/frames.db");
const outDir = path.resolve("data/frames");

// sftp needs a running machine and refuses to overwrite files.
await fetch(`https://${app}.fly.dev/healthz`);
mkdirSync(outDir, { recursive: true });
rmSync(local, { force: true });
execFileSync("fly", ["ssh", "sftp", "get", "-a", app, "/data/frames.db", local], { stdio: "inherit" });

const db = new Database(local, { readonly: true });
const rows = db.prepare("SELECT id, created_at, meta, image FROM frames ORDER BY id").all() as Array<{
  id: number;
  created_at: number;
  meta: string;
  image: Buffer;
}>;
for (const row of rows) {
  const meta = JSON.parse(row.meta) as { kind?: string };
  const name = `${new Date(row.created_at).toISOString().replace(/[:.]/g, "-")}-${row.id}-${meta.kind ?? "labels"}`;
  writeFileSync(path.join(outDir, `${name}.jpg`), row.image);
  writeFileSync(path.join(outDir, `${name}.json`), JSON.stringify(meta, null, 2));
}
console.log(`${rows.length} frames in ${outDir}`);
