import type { Context, Next } from "hono";

function clientIp(c: Context) {
  return c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function rateLimit({ perMinute, perDay }: { perMinute: number; perDay: number }) {
  const hits = new Map<string, number[]>();
  return async (c: Context, next: Next) => {
    const now = Date.now();
    const ip = clientIp(c);
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < 86_400_000);
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
