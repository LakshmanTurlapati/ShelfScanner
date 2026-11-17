import type { Context, Next } from "hono";

function clientIp(c: Context) {
  return c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

const DAY_MS = 86_400_000;
const SWEEP_MS = 10 * 60_000;

// Drops addresses with no hit in the last day, so the maps do not grow with every IP ever seen.
export function sweepHits(hits: Map<string, number[]>, now = Date.now()) {
  for (const [ip, times] of hits) {
    const recent = times.filter((t) => now - t < DAY_MS);
    if (recent.length) hits.set(ip, recent);
    else hits.delete(ip);
  }
}

export function rateLimit({ perMinute, perDay }: { perMinute: number; perDay: number }) {
  const hits = new Map<string, number[]>();
  setInterval(() => sweepHits(hits), SWEEP_MS).unref();
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const ip = clientIp(c);
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < DAY_MS);
    const minute = recent.filter((t) => now - t < 60_000);
    if (minute.length >= perMinute || recent.length >= perDay) {
      c.header("Retry-After", "60");
      return c.text("slow down", 429);
    }
    recent.push(now);
    hits.set(ip, recent);
    await next();
  };
}

const TITLE_CAP = 200;

export function capped(value: unknown) {
  return typeof value === "string" && value.length <= TITLE_CAP;
}

/** Parses a JSON body; a malformed one becomes undefined so the route's schema answers 400. */
export async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
