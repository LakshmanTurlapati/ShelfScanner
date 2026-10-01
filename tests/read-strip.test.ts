import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openrouterLines } from "../server/openrouter.ts";
import { readByLines, readStrip } from "../server/routes/read-strip.ts";

const encoder = new TextEncoder();
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const app = new Hono().post("/api/read-strip", readStrip);

const data = (json: unknown) => `data: ${JSON.stringify(json)}\n\n`;
const text = (content: string) => data({ model: "google/gemini-3.1-flash-lite", provider: "Google", choices: [{ delta: { content } }] });
const finish = data({ choices: [{ delta: { content: "" }, finish_reason: "stop" }], usage: { prompt_tokens: 900, completion_tokens: 60 } });

type Reply = { events: string[]; open?: boolean; closeAfterMs?: number; status?: number };

// Streams the events like OpenRouter would, in small pieces; an open stream waits until it is aborted.
function sse({ events, open = false, closeAfterMs, status = 200 }: Reply, signal?: AbortSignal | null) {
  if (status !== 200) return new Response("upstream error", { status });
  const bytes = encoder.encode(events.join(""));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      signal?.addEventListener("abort", () => controller.error(signal.reason));
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      if (closeAfterMs) setTimeout(() => controller.close(), closeAfterMs);
      else if (!open) controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

function stubOpenRouter(...replies: Reply[]) {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init!.signal!);
    return sse(replies[Math.min(fetch.mock.calls.length - 1, replies.length - 1)], init?.signal);
  });
  vi.stubGlobal("fetch", fetch);
  const bodies = () => fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
  return { fetch, signals, bodies };
}

const post = () => app.request("/api/read-strip?strip=1&of=2", { method: "POST", headers: { "content-type": "image/jpeg" }, body: jpeg });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("streamed lines", () => {
  it("yields complete lines, skipping comments, and the last line without a newline", async () => {
    stubOpenRouter({ events: [": OPENROUTER PROCESSING\n\n", text("a|b\nc"), text("d\n\n"), text("last"), finish, "data: [DONE]\n\n"] });
    const lines: string[] = [];
    for await (const line of openrouterLines({})) lines.push(line);
    expect(lines).toEqual(["a|b", "cd", "last"]);
  });

  it("keeps lines already read when the stream stalls, but throws when it never starts", async () => {
    stubOpenRouter({ events: [text("first\nsecond")], open: true });
    const lines: string[] = [];
    for await (const line of openrouterLines({}, { idleMs: 50 })) lines.push(line);
    expect(lines).toEqual(["first"]);

    stubOpenRouter({ events: [": OPENROUTER PROCESSING\n\n"], open: true });
    await expect(async () => {
      for await (const _ of openrouterLines({}, { firstByteMs: 50 })) void _;
    }).rejects.toThrow("first-byte timeout");
  });

  it("treats a stream that stalls before its first line as failed", async () => {
    stubOpenRouter({ events: [data({ choices: [{ delta: { role: "assistant", content: "" } }] }), text("half a li")], open: true });
    await expect(async () => {
      for await (const _ of openrouterLines({}, { idleMs: 50 })) void _;
    }).rejects.toThrow("idle timeout");
  });

  it("throws on an error chunk and retries a 5xx once", async () => {
    stubOpenRouter({ events: [text("one\n"), data({ error: { message: "overloaded" }, choices: [{ finish_reason: "error" }] })] });
    const lines: string[] = [];
    await expect(async () => {
      for await (const line of openrouterLines({})) lines.push(line);
    }).rejects.toThrow("overloaded");
    expect(lines).toEqual(["one"]);

    const { fetch } = stubOpenRouter({ events: [], status: 503 }, { events: [text("ok\n")] });
    const retried: string[] = [];
    for await (const line of openrouterLines({})) retried.push(line);
    expect(retried).toEqual(["ok"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("read-strip lines mode", () => {
  it("sends the benchmarked request and returns placed spines", async () => {
    const { bodies } = stubOpenRouter({ events: [
      text("1|100 0 900 100|9|Le"),
      text("ft|\n1|100 200 900 300|8|The Hobbit|J.R.R. Tolkien\n"),
      text("1|100 400 900 500|2|?|"),
      finish,
      "data: [DONE]\n\n",
    ] });
    const res = await post();
    expect(res.status).toBe(200);
    const { spines } = await res.json();
    expect(spines.map((spine: { title: string; placement: string }) => [spine.title, spine.placement])).toEqual([
      ["Left", "matched"],
      ["The Hobbit", "matched"],
      ["", "unmatched-box"],
    ]);
    expect(spines[1]).toMatchObject({ author: "J.R.R. Tolkien", confidence: 0.85, x: 0.2, y: 0.1, w: 0.1, h: 0.8 });
    const [body] = bodies();
    expect(body).toMatchObject({
      model: "google/gemini-3.1-flash-lite",
      stream: true,
      max_tokens: 1200,
      reasoning: { effort: "minimal", exclude: true },
      provider: { order: ["google-ai-studio", "google-vertex/global"], allow_fallbacks: true },
      service_tier: "priority",
    });
    expect(body.messages[1].content[0]).toEqual({ type: "text", text: "Strip 1 of 2." });
    expect(body.messages[1].content[1].image_url.url).toBe(`data:image/jpeg;base64,${jpeg.toString("base64")}`);
  });

  it("stops and cancels a model that repeats itself", async () => {
    const repeat = "1|100 100 900 200|9|Dune|Herbert\n";
    const { signals } = stubOpenRouter({ events: [text("1|100 0 900 90|9|Emma|Austen\n"), ...Array(10).fill(text(repeat)), text("1|100 300 900 400|9|Never reached|\n")], open: true });
    const started = Date.now();
    const { spines } = await (await post()).json();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(spines.map((spine: { title: string }) => spine.title)).toEqual(["Emma", "Dune"]);
    expect(signals[0].aborted).toBe(true);
  });

  it("hedges through the other provider when the first request stalls", async () => {
    const { bodies, signals } = stubOpenRouter(
      { events: [": OPENROUTER PROCESSING\n\n"], open: true },
      { events: [text("1|100 0 900 100|9|Emma|Austen\n"), finish, "data: [DONE]\n\n"] },
    );
    const read = await readByLines(jpeg, 1, 1, new AbortController().signal, 30);
    expect(read).toMatchObject({ hedged: true, failed: false, errors: [] });
    expect(read.lines.map((line) => line.title)).toEqual(["Emma"]);
    expect(bodies().map((body) => body.provider.order)).toEqual([
      ["google-ai-studio", "google-vertex/global"],
      ["google-vertex/global", "google-ai-studio"],
    ]);
    expect(signals[0].aborted).toBe(true);
  });

  it("hedges at once when the first request fails", async () => {
    const { fetch } = stubOpenRouter({ events: [], status: 400 }, { events: [text("1|100 0 900 100|9|Emma|Austen\n")] });
    const read = await readByLines(jpeg, 1, 1, new AbortController().signal, 10_000);
    expect(read.lines.map((line) => line.title)).toEqual(["Emma"]);
    expect(read.errors).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not hedge once the first request has read a spine", async () => {
    const { fetch } = stubOpenRouter({ events: [text("1|100 0 900 100|9|Emma|Austen\n")], closeAfterMs: 80 });
    const read = await readByLines(jpeg, 1, 1, new AbortController().signal, 20);
    expect(read).toMatchObject({ hedged: false, failed: false });
    expect(read.lines).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("answers 502 only when both requests fail", async () => {
    const { fetch } = stubOpenRouter({ events: [], status: 503 });
    const res = await post();
    expect(res.status).toBe(502);
    expect(await res.text()).toBe("spine read failed");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
