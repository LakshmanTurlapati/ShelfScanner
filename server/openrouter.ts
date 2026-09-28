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

function logUsage(pathName: string, json: { model?: string; id?: string; usage?: Record<string, unknown> }, started: number) {
  const usage = json.usage ?? {};
  console.log(
    JSON.stringify({
      route: pathName,
      model: json.model ?? null,
      tokens: usage,
      searches: (usage.server_tool_use as { web_search_requests?: number } | undefined)?.web_search_requests ?? 0,
      generation: json.id ?? null,
      ms: Date.now() - started,
    }),
  );
}

export async function openrouter(pathName: string, body: unknown, timeoutMs = 45_000) {
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
      if (attempt >= 2 || !isRetryable(err)) throw err;
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
