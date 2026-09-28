import { timingSafeEqual } from "node:crypto";
import type { Context, Next } from "hono";

const hits = new Map<string, number[]>();

function clientIp(c: Context) {
  return c.req.header("fly-client-ip") || c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

export function accessCode() {
  return async (c: Context, next: Next) => {
    const expected = process.env.ACCESS_CODE ?? "";
    if (!expected) return c.text("ACCESS_CODE is not set", 503);
    const given = c.req.header("x-access-code") ?? "";
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return c.text("missing access code", 401);
    await next();
  };
}

export function rateLimit({ perMinute, perDay }: { perMinute: number; perDay: number }) {
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
