import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function readPrompt(name: string) {
  const candidates = [
    path.join(here, "prompts", name),
    path.join(process.cwd(), "server/prompts", name),
  ];
  for (const file of candidates) {
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error(`missing prompt ${name}`);
}
