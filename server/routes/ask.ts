import type { Context } from "hono";
import { z } from "zod";
import { MODELS } from "../../shared/models.ts";
import { capped } from "../guards.ts";
import { openrouterStream } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";

const rules = readPrompt("ask.md");
const bodySchema = z.object({
  question: z.string().max(500),
  books: z.array(z.record(z.string(), z.unknown())).max(200),
});

export async function ask(c: Context) {
  const parsed = bodySchema.safeParse(await c.req.json());
  if (!parsed.success || !capped(parsed.data.question)) return c.text("invalid question", 400);
  const compact = parsed.data.books.map((book) => ({
    key: book.key,
    title: book.canonicalTitle ?? book.key,
    authors: book.authors,
    genres: [book.primaryGenre, ...(Array.isArray(book.secondaryGenres) ? book.secondaryGenres : [])],
    summary: book.summary,
    rating: book.avgRating,
  }));
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
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
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
            try {
              const json = JSON.parse(data);
              const text = json.choices?.[0]?.delta?.content;
              if (typeof text === "string" && text) controller.enqueue(encoder.encode(text));
            } catch {
              // ignore a partial SSE frame
            }
          }
        }
      } finally {
        controller.close();
      }
    },
  });
  return c.body(stream, 200, { "content-type": "text/plain; charset=utf-8" });
}
