import { afterEach, describe, expect, it, vi } from "vitest";
import { askShelf, OfflineError, readStrip } from "../web/src/api.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ask the shelf", () => {
  it("passes each chunk of the answer through as it arrives", async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("The "));
        controller.enqueue(new TextEncoder().encode("best one."));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { status: 200, headers: { "content-type": "text/plain" } })));
    const parts: string[] = [];
    await askShelf("Which book?", [{ key: "hobbit" }], (part) => parts.push(part));
    expect(parts.join("")).toBe("The best one.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stops before the request when the phone is offline", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const online = Object.getOwnPropertyDescriptor(navigator, "onLine");
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false });
    await expect(readStrip(new Blob(["x"]), 1, 1)).rejects.toBeInstanceOf(OfflineError);
    expect(fetch).not.toHaveBeenCalled();
    if (online) Object.defineProperty(navigator, "onLine", online);
    else Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  });
});
