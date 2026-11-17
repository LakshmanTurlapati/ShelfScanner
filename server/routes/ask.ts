import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import { capped, readJson } from "../guards.ts";
import { openrouterStream } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";

const rules = readPrompt("ask.md");
const bodySchema = z.object({
  question: z.string().max(500),
  books: z.array(z.record(z.string(), z.unknown())).max(200),
});

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function shelfRecords(books: Record<string, unknown>[]) {
  return books.map((book) => {
    const title = text(book.canonicalTitle) || text((book.detections as { title?: unknown }[] | undefined)?.[0]?.title) || "Unread spine";
    const authors = Array.isArray(book.authors) ? book.authors.filter((author) => typeof author === "string" && author.trim()) : [];
    const genres = [book.primaryGenre, ...(Array.isArray(book.secondaryGenres) ? book.secondaryGenres : [])].filter((genre) => typeof genre === "string" && genre);
    return {
      title,
      authors,
      genres,
      summary: typeof book.summary === "string" ? book.summary : null,
      rating: typeof book.avgRating === "number" ? book.avgRating : null,
    };
  });
}

export async function ask(c: Context) {
  const parsed = bodySchema.safeParse(await readJson(c));
  if (!parsed.success || !capped(parsed.data.question)) return c.text("invalid question", 400);
  const compact = shelfRecords(parsed.data.books);
  let upstream: ReadableStream<Uint8Array>;
  try {
    upstream = await openrouterStream({
      model: MODELS.ask,
      messages: [
        { role: "system", content: rules },
        { role: "user", content: `${parsed.data.question}\n\n${JSON.stringify(compact)}` },
      ],
      reasoning: { effort: "low" },
    });
  } catch {
    return c.text("ask failed", 502);
  }
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let left = false;
  // A failure (an upstream error frame, a dropped connection, the 45 s timeout) errors the body
  // instead of closing it, so the phone reports a broken answer rather than a short one.
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (data === "[DONE]") continue;
            let json: { error?: unknown; choices?: Array<{ delta?: { content?: unknown } }> };
            try {
              json = JSON.parse(data);
            } catch {
              continue; // a partial SSE frame
            }
            if (json.error) throw new Error("upstream error");
            const text = json.choices?.[0]?.delta?.content;
            if (typeof text === "string" && text) controller.enqueue(encoder.encode(text));
          }
        }
        controller.close();
      } catch (error) {
        if (left) return;
        console.log(JSON.stringify({ route: "/api/ask", failed: "stream", error: error instanceof Error ? error.name : "unknown" }));
        await reader.cancel().catch(() => undefined);
        controller.error(error);
      }
    },
    // The phone left; stop the model too.
    cancel() {
      left = true;
      return reader.cancel().catch(() => undefined);
    },
  });
  return c.body(stream, 200, { "content-type": "text/plain; charset=utf-8" });
}
