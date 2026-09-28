import type { Context } from "hono";
import { MODELS } from "../../shared/models.ts";
import { Spines, SPINES_JSON_SCHEMA } from "../../shared/schemas.ts";
import { openrouter } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";

const rules = readPrompt("spines.md");

async function once(image: Buffer, strip: number, of: number) {
  const json = await openrouter("/chat/completions", {
    model: MODELS.spines,
    messages: [
      { role: "system", content: rules },
      {
        role: "user",
        content: [
          { type: "text", text: `Strip ${strip} of ${of}. Read every spine.` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image.toString("base64")}` } },
        ],
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "spines", strict: true, schema: SPINES_JSON_SCHEMA },
    },
    provider: { require_parameters: true },
    plugins: [{ id: "response-healing" }],
    reasoning: { effort: "low" },
  });
  const content = json?.choices?.[0]?.message?.content;
  const parsed = Spines.safeParse(typeof content === "string" ? JSON.parse(content) : content);
  if (!parsed.success) throw new Error("spine schema");
  return parsed.data;
}

export async function readStrip(c: Context) {
  const strip = Number(c.req.query("strip") ?? "1");
  const of = Number(c.req.query("of") ?? "1");
  if (!Number.isInteger(strip) || strip < 1 || !Number.isInteger(of) || of < 1) {
    return c.text("invalid strip", 400);
  }
  const image = Buffer.from(await c.req.arrayBuffer());
  if (image.length === 0) return c.text("empty image", 400);
  try {
    return c.json(await once(image, strip, of));
  } catch {
    try {
      return c.json(await once(image, strip, of));
    } catch {
      return c.text("spine read failed", 502);
    }
  }
}
