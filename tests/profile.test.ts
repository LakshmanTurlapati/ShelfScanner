import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PROFILE_KEY, clearProfile, loadProfile, saveProfile, skipProfile } from "../web/src/profile.ts";
import { useShelf } from "../web/src/store.ts";

const mem = vi.hoisted(() => {
  const values = new Map<string, unknown>();
  const calls: { op: string; key: string; value?: unknown }[] = [];
  return { values, calls };
});

vi.mock("idb-keyval", () => ({
  get: async (key: string) => {
    mem.calls.push({ op: "get", key });
    return mem.values.get(key);
  },
  set: async (key: string, value: unknown) => {
    mem.calls.push({ op: "set", key, value });
    mem.values.set(key, value);
  },
  del: async (key: string) => {
    mem.calls.push({ op: "del", key });
    mem.values.delete(key);
  },
}));

afterEach(() => {
  mem.values.clear();
  mem.calls.length = 0;
});

describe("profile key", () => {
  it("loads null when the key is absent and remembers an explicit skip", async () => {
    expect(await loadProfile()).toBeNull();
    await skipProfile();
    expect(await loadProfile()).toEqual({ status: "skipped" });
    expect(mem.calls.filter((call) => call.op === "set").every((call) => call.key === PROFILE_KEY)).toBe(true);
  });

  it("saves a blank finish and replaces a skip without touching sessions", async () => {
    await skipProfile();
    await saveProfile({ name: "", genres: ["fantasy", "not-a-genre", "fantasy"], picks: [{ prefer: "", over: "Dune" }, { prefer: "Dune", over: "Neuromancer" }] });
    expect(await loadProfile()).toEqual({
      status: "saved",
      name: "",
      genres: ["fantasy"],
      picks: [{ prefer: "Dune", over: "Neuromancer" }],
    });
    expect(mem.calls.some((call) => call.key === "shelf-scanner-sessions")).toBe(false);
  });

  it("treats a half-finished or unknown status as absent", async () => {
    mem.values.set(PROFILE_KEY, { status: "draft", name: "Ada" });
    expect(await loadProfile()).toBeNull();
  });

  it("clears the profile back to absent and leaves scans to clearLocal", async () => {
    await saveProfile({ name: "Ada", genres: ["fantasy"], picks: [] });
    await clearProfile();
    expect(await loadProfile()).toBeNull();
    expect(mem.calls.some((call) => call.op === "del" && call.key === PROFILE_KEY)).toBe(true);

    await saveProfile({ name: "Ada", genres: [], picks: [] });
    mem.calls.length = 0;
    useShelf.getState().clearLocal();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(mem.calls.filter((call) => call.op === "set").map((call) => call.key)).toEqual(["shelf-scanner-sessions"]);
    expect(mem.calls.some((call) => call.op === "del")).toBe(false);
    expect(await loadProfile()).toEqual({ status: "saved", name: "Ada", genres: [], picks: [] });
  });

  it("does not import or call clear or createStore", () => {
    const source = readFileSync(new URL("../web/src/profile.ts", import.meta.url), "utf8");
    const code = source.replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/\bclear\b/);
    expect(code).not.toMatch(/\bcreateStore\b/);
    expect(source).toContain("del(PROFILE_KEY)");
    expect(source).not.toContain("fetch(");
    expect(source).not.toContain("console.log");
  });
});
