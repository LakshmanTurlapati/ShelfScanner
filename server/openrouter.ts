import { searchCount, type SearchUsage } from "./verify.ts";

const BASE = "https://openrouter.ai/api/v1";

export class Retryable extends Error {
  constructor(readonly status: number) {
    super(`retryable ${status}`);
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryable(err: unknown) {
  if (err instanceof Retryable) return true;
  if (err instanceof Error) {
    const message = err.message.toLowerCase();
    return message.includes("timeout") || message.includes("econnreset") || err.name === "TimeoutError" || err.name === "AbortError";
  }
  return false;
}

type ChatUsageJson = {
  model?: string;
  id?: string;
  provider?: string;
  usage?: Record<string, unknown> & SearchUsage;
  choices?: Array<{ finish_reason?: string | null }>;
};

function logUsage(pathName: string, json: ChatUsageJson, started: number) {
  const usage = json.usage ?? {};
  console.log(
    JSON.stringify({
      route: pathName,
      model: json.model ?? null,
      provider: json.provider ?? null,
      finish: json.choices?.[0]?.finish_reason ?? null,
      tokens: usage,
      searches: searchCount(usage),
      generation: json.id ?? null,
      ms: Date.now() - started,
    }),
  );
}

export async function openrouter(
  pathName: string,
  body: unknown,
  { timeoutMs = 45_000, retryTimeouts = true }: { timeoutMs?: number; retryTimeouts?: boolean } = {},
) {
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${BASE}${pathName}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_URL ?? "",
          "X-Title": "Shelf Scanner",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) throw new Retryable(res.status);
      if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
      const json = await res.json();
      logUsage(pathName, json, started);
      return json;
    } catch (err) {
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      if (attempt >= 2 || !isRetryable(err) || (timedOut && !retryTimeouts)) throw err;
      await sleep(500 * 2 ** attempt + Math.random() * 250);
    }
  }
}

export async function openrouterStream(body: unknown, timeoutMs = 45_000) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL ?? "",
      "X-Title": "Shelf Scanner",
    },
    body: JSON.stringify({ ...(body as object), stream: true }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok || !res.body) throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  return res.body;
}

class StreamTimeout extends Error {
  constructor(readonly kind: "first-byte" | "idle" | "total") {
    super(`${kind} timeout`);
    this.name = "TimeoutError";
  }
}

type StreamChunk = ChatUsageJson & {
  error?: unknown;
  choices?: Array<{ finish_reason?: string | null; delta?: { content?: unknown } }>;
};

function postStream(body: object, signal: AbortSignal) {
  return fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.APP_URL ?? "",
      "X-Title": "Shelf Scanner",
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  });
}

function streamChunk(line: string): StreamChunk | "done" | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "[DONE]") return "done";
  try {
    return JSON.parse(data) as StreamChunk;
  } catch {
    return null;
  }
}

export type LineLimits = { signal?: AbortSignal; firstByteMs?: number; idleMs?: number; totalMs?: number };

// Yields each complete line of the model's text as it streams. A stream that never yields a
// line throws; one that stalls or runs long after that ends early, keeping the lines already yielded.
export async function* openrouterLines(
  body: object,
  { signal, firstByteMs = 4000, idleMs = 1500, totalMs = 8000 }: LineLimits = {},
): AsyncGenerator<string> {
  const started = Date.now();
  const local = new AbortController();
  const combined = signal ? AbortSignal.any([signal, local.signal]) : local.signal;
  const timeout = (kind: StreamTimeout["kind"], ms: number) => setTimeout(() => local.abort(new StreamTimeout(kind)), ms);
  let stall = timeout("first-byte", firstByteMs);
  const total = timeout("total", totalMs);
  const seen: ChatUsageJson = {};
  let finish: string | null = null;
  let ttft: number | null = null;
  let firstLine: number | null = null;
  let lines = 0;
  let ended = false;
  try {
    let res = await postStream(body, combined);
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel();
      res = await postStream(body, combined);
    }
    if (!res.ok || !res.body) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sse = "";
    let text = "";
    read: for (;;) {
      const next = await reader.read();
      sse += next.done ? "\n" : decoder.decode(next.value, { stream: true });
      const events = sse.split("\n");
      sse = events.pop() ?? "";
      // OpenRouter sends ": comment" lines while the model is queued, so only data counts as progress.
      for (const event of events) {
        const chunk = streamChunk(event.trim());
        if (chunk === "done") break read;
        if (!chunk) continue;
        clearTimeout(stall);
        stall = timeout("idle", idleMs);
        seen.model ??= chunk.model;
        seen.provider ??= chunk.provider;
        seen.id ??= chunk.id;
        if (chunk.usage) seen.usage = chunk.usage;
        const choice = chunk.choices?.[0];
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (chunk.error || finish === "error") {
          throw new Error(`OpenRouter stream error: ${JSON.stringify(chunk.error ?? choice).slice(0, 300)}`);
        }
        const delta = choice?.delta?.content;
        if (typeof delta !== "string" || !delta) continue;
        ttft ??= Date.now() - started;
        text += delta;
        for (let end = text.indexOf("\n"); end >= 0; end = text.indexOf("\n")) {
          const line = text.slice(0, end).trim();
          text = text.slice(end + 1);
          if (!line) continue;
          firstLine ??= Date.now() - started;
          lines++;
          yield line;
        }
      }
      if (next.done) break;
    }
    if (text.trim()) {
      firstLine ??= Date.now() - started;
      lines++;
      yield text.trim();
    }
    ended = true;
  } catch (err) {
    ended = true;
    const reason = local.signal.reason;
    finish ??= reason instanceof StreamTimeout ? reason.kind : combined.aborted ? "aborted" : "error";
    // A stall before any line is a failed read, so the caller can hedge or report it.
    if (!(reason instanceof StreamTimeout) || reason.kind === "first-byte" || lines === 0) throw reason ?? err;
  } finally {
    clearTimeout(stall);
    clearTimeout(total);
    local.abort();
    console.log(
      JSON.stringify({
        route: "/chat/completions",
        model: seen.model ?? null,
        provider: seen.provider ?? null,
        finish: finish ?? (ended ? null : "stopped"),
        tokens: seen.usage ?? {},
        generation: seen.id ?? null,
        ttft_ms: ttft,
        first_line_ms: firstLine,
        lines,
        ms: Date.now() - started,
      }),
    );
  }
}
