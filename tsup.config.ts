import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "server/index.ts" },
  outDir: "dist/server",
  format: ["esm"],
  target: "node24",
  platform: "node",
  clean: true,
  sourcemap: true,
  external: ["better-sqlite3"],
});
