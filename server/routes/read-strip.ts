import type { Context } from "hono";
import { MODELS } from "../../shared/models.ts";
import { pairSpines, parsePointBoxes, parseTextSpines } from "../pair-spines.ts";
import { openrouter, openrouterLines } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";
import { LineGuard, linesToSpines, parseSpineLine, type SpineLine } from "../read-lines.ts";

const textRules = readPrompt("spines.md");
const boxRules = readPrompt("boxes.md");
const lineRules = readPrompt("read.md");
const PROVIDERS = ["google-ai-studio", "google-vertex/global"];
const HEDGE_MS = 2000;

// Normal reads stay under 2,000 tokens. The cap and single timeout stop a model
// that starts repeating itself instead of letting it run for minutes.
const MAX_TOKENS = 3000;
const LIMITS = { timeoutMs: 60_000, retryTimeouts: false };

type ChatJson = { choices?: Array<{ message?: { content?: unknown } }> };

function messageText(json: ChatJson) {
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  if (content && typeof content === "object") return JSON.stringify(content);
  return "";
}

function imageMessage(text: string, image: Buffer) {
  return {
    role: "user" as const,
    content: [
      { type: "text", text },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } },
    ],
  };
}

// A 404 means no provider for the model accepts the requested parameters.
function rejected(err: unknown) {
  return err instanceof Error && /OpenRouter 40[04]/.test(err.message);
}

async function readBoxes(image: Buffer, strip: number, of: number) {
  const ask = (withConfig: boolean) =>
    openrouter("/chat/completions", {
      model: MODELS.boxes,
      messages: [
        { role: "system", content: boxRules },
        imageMessage(`Strip ${strip} of ${of}. Mark every book spine.`, image),
      ],
      max_tokens: MAX_TOKENS,
      ...(withConfig ? { vision_config: { annotation_format: "box", enable_thinking: false } } : {}),
    }, LIMITS).then((json) => parsePointBoxes(messageText(json)));
  try {
    return await ask(true);
  } catch (err) {
    if (!rejected(err)) throw err;
    return ask(false);
  }
}

// The text model's only provider does not support response schemas, so it is asked for plain JSON.
function readText(image: Buffer, strip: number, of: number) {
  return openrouter("/chat/completions", {
    model: MODELS.spineText,
    messages: [
      { role: "system", content: textRules },
      imageMessage(`Strip ${strip} of ${of}. Read every spine.`, image),
    ],
    reasoning: { enabled: false },
    max_tokens: MAX_TOKENS,
  }, LIMITS).then((json) => parseTextSpines(messageText(json)));
}

function lineBody(image: Buffer, strip: number, of: number, order: string[]) {
  return {
    model: MODELS.read,
    stream: true,
    max_tokens: 1200,
    reasoning: { effort: "minimal", exclude: true },
    provider: { order, allow_fallbacks: true },
    service_tier: "priority",
    messages: [{ role: "system", content: lineRules }, imageMessage(`Strip ${strip} of ${of}.`, image)],
  };
}

// When no spine has arrived after hedgeMs (or the first request fails), a second request goes
// through the other provider first. The first request to read a spine is kept; the other is cancelled.
export async function readByLines(image: Buffer, strip: number, of: number, signal: AbortSignal, hedgeMs = HEDGE_MS) {
  const guard = new LineGuard();
  const lines: SpineLine[] = [];
  const errors: string[] = [];
  const controllers: AbortController[] = [];
  let winner: AbortController | null = null;

  async function request(order: string[]) {
    const own = new AbortController();
    controllers.push(own);
    try {
      const stream = openrouterLines(lineBody(image, strip, of, order), { signal: AbortSignal.any([signal, own.signal]) });
      for await (const text of stream) {
        if (winner && winner !== own) break;
        const line = parseSpineLine(text);
        if (line && guard.accept(line)) {
          if (!winner) {
            winner = own;
            for (const other of controllers) if (other !== own) other.abort();
          }
          lines.push(line);
        }
        if (guard.stopped) break;
      }
      return true;
    } catch (err) {
      if (!own.signal.aborted && !signal.aborted) errors.push(String(err).slice(0, 300));
      return false;
    }
  }

  const runs = [request(PROVIDERS)];
  const hedge = () => {
    if (runs.length === 1 && !winner && !signal.aborted) runs.push(request([...PROVIDERS].reverse()));
  };
  const timer = setTimeout(hedge, hedgeMs);
  const primaryOk = await runs[0];
  clearTimeout(timer);
  if (!primaryOk) hedge();
  const results = await Promise.all(runs);
  return { lines, errors, hedged: runs.length > 1, failed: lines.length === 0 && !results.some(Boolean) };
}

async function readPair(c: Context, image: Buffer, strip: number, of: number) {
  const [boxes, texts] = await Promise.allSettled([readBoxes(image, strip, of), readText(image, strip, of)]);
  for (const [failed, result] of [["boxes", boxes], ["text", texts]] as const) {
    if (result.status === "rejected") {
      console.log(JSON.stringify({ route: "/api/read-strip", failed, error: String(result.reason).slice(0, 300) }));
    }
  }
  if (boxes.status === "rejected" && texts.status === "rejected") return c.text("spine read failed", 502);
  return c.json({
    spines: pairSpines(
      texts.status === "fulfilled" ? texts.value : [],
      boxes.status === "fulfilled" ? boxes.value : [],
    ),
  });
}

export async function readStrip(c: Context) {
  const strip = Number(c.req.query("strip") ?? "1");
  const of = Number(c.req.query("of") ?? "1");
  if (!Number.isInteger(strip) || strip < 1 || !Number.isInteger(of) || of < 1) {
    return c.text("invalid strip", 400);
  }
  const image = Buffer.from(await c.req.arrayBuffer());
  if (image.length === 0) return c.text("empty image", 400);
  if (process.env.READ_MODE === "pair") return readPair(c, image, strip, of);
  const started = Date.now();
  const read = await readByLines(image, strip, of, c.req.raw.signal);
  const spines = linesToSpines(read.lines);
  console.log(JSON.stringify({
    route: "/api/read-strip",
    mode: "lines",
    lines: read.lines.length,
    spines: spines.length,
    hedged: read.hedged,
    ms: Date.now() - started,
    ...(read.errors.length ? { errors: read.errors } : {}),
  }));
  if (read.failed) return c.text("spine read failed", 502);
  return c.json({ spines });
}
