import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { beforeAll, describe, expect, it } from "vitest";

const file = path.join(mkdtempSync(path.join(tmpdir(), "frames-")), "frames.db");
let app: Hono;
let trimFrames: (max?: number) => void;

beforeAll(async () => {
  process.env.FRAMES_DB = file;
  const route = await import("../server/routes/frames.ts");
  trimFrames = route.trimFrames;
  app = new Hono().post("/api/frames", route.saveFrame);
});

function post(image: Uint8Array<ArrayBuffer>, meta: unknown = { captureId: "abc", labels: [] }) {
  const form = new FormData();
  form.append("image", new Blob([image], { type: "image/jpeg" }), "frame.jpg");
  form.append("meta", JSON.stringify(meta));
  return app.request("/api/frames", { method: "POST", body: form });
}

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const ids = () => (new Database(file, { readonly: true }).prepare("SELECT id FROM frames ORDER BY id").all() as Array<{ id: number }>).map((row) => row.id);

describe("labeled frame storage", () => {
  it("stores a JPEG with its capture id and meta", async () => {
    const res = await post(jpeg);
    expect(res.status).toBe(204);
    const row = new Database(file, { readonly: true }).prepare("SELECT capture_id, meta, image FROM frames").get() as { capture_id: string; meta: string; image: Buffer };
    expect(row.capture_id).toBe("abc");
    expect(JSON.parse(row.meta)).toEqual({ captureId: "abc", labels: [] });
    expect([...row.image]).toEqual([...jpeg]);
  });

  it("rejects anything that is not a JPEG", async () => {
    expect((await post(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).status).toBe(400);
  });

  it("keeps only the newest frames when full", async () => {
    for (let i = 0; i < 4; i++) await post(jpeg);
    const before = ids();
    trimFrames(3);
    expect(ids()).toEqual(before.slice(-3));
  });
});
