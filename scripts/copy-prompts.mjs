import { cpSync, mkdirSync } from "node:fs";

mkdirSync("dist/server/prompts", { recursive: true });
cpSync("server/prompts", "dist/server/prompts", { recursive: true });
