import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { rateLimit } from "./guards.ts";
import { ask } from "./routes/ask.ts";
import { embed } from "./routes/embed.ts";
import { enrich } from "./routes/enrich.ts";
import { readStrip } from "./routes/read-strip.ts";

function loadEnv() {
  const file = path.resolve(".env");
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnv();

const app = new Hono();

app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  console.log(
    JSON.stringify({
      route: c.req.path,
      status: c.res.status,
      ms: Date.now() - started,
    }),
  );
});

app.get("/healthz", (c) => c.text("ok"));
app.use("/api/*", rateLimit({ perMinute: 60, perDay: 600 }));
app.post("/api/read-strip", bodyLimit({ maxSize: 3 * 1024 * 1024 }), readStrip);
app.post("/api/enrich", bodyLimit({ maxSize: 8 * 1024 }), enrich);
app.post("/api/embed", bodyLimit({ maxSize: 256 * 1024 }), embed);
app.post("/api/ask", bodyLimit({ maxSize: 256 * 1024 }), ask);

const webRoot = "./dist/web";
if (existsSync(webRoot)) {
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
}

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => {
  console.log(JSON.stringify({ route: "listen", status: 0, ms: 0, port }));
});
