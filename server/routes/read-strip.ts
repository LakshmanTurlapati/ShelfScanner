import type { Context } from "hono";
import { MODELS } from "../../shared/models.ts";
import { TEXT_SPINES_JSON_SCHEMA } from "../../shared/schemas.ts";
import { pairSpines, parsePointBoxes, parseTextSpines } from "../pair-spines.ts";
import { openrouter } from "../openrouter.ts";
import { readPrompt } from "../prompts.ts";

const textRules = readPrompt("spines.md");
const boxRules = readPrompt("boxes.md");

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

function rejected(err: unknown) {
  return err instanceof Error && err.message.includes("OpenRouter 400");
}

async function readBoxes(image: Buffer, strip: number, of: number) {
  const ask = (withConfig: boolean) =>
    openrouter("/chat/completions", {
      model: MODELS.boxes,
      messages: [
        { role: "system", content: boxRules },
        imageMessage(`Strip ${strip} of ${of}. Mark every book spine.`, image),
      ],
      ...(withConfig ? { vision_config: { annotation_format: "box", enable_thinking: false } } : {}),
    }).then((json) => parsePointBoxes(messageText(json)));
  try {
    return await ask(true);
  } catch (err) {
    if (!rejected(err)) throw err;
    return ask(false);
  }
}

async function readText(image: Buffer, strip: number, of: number) {
  const ask = (withSchema: boolean) =>
    openrouter("/chat/completions", {
      model: MODELS.spineText,
      messages: [
        { role: "system", content: textRules },
        imageMessage(`Strip ${strip} of ${of}. Read every spine.`, image),
      ],
      ...(withSchema
        ? {
            response_format: {
              type: "json_schema",
              json_schema: { name: "spines", strict: true, schema: TEXT_SPINES_JSON_SCHEMA },
            },
            provider: { require_parameters: true },
            plugins: [{ id: "response-healing" }],
          }
        : {}),
      reasoning: { enabled: false },
    }).then((json) => parseTextSpines(messageText(json)));
  try {
    return await ask(true);
  } catch (err) {
    return ask(!rejected(err));
  }
}

export async function readStrip(c: Context) {
  const strip = Number(c.req.query("strip") ?? "1");
  const of = Number(c.req.query("of") ?? "1");
  if (!Number.isInteger(strip) || strip < 1 || !Number.isInteger(of) || of < 1) {
    return c.text("invalid strip", 400);
  }
  const image = Buffer.from(await c.req.arrayBuffer());
  if (image.length === 0) return c.text("empty image", 400);
  const [boxes, texts] = await Promise.allSettled([readBoxes(image, strip, of), readText(image, strip, of)]);
  if (boxes.status === "rejected" && texts.status === "rejected") return c.text("spine read failed", 502);
  return c.json({
    spines: pairSpines(
      texts.status === "fulfilled" ? texts.value : [],
      boxes.status === "fulfilled" ? boxes.value : [],
    ),
  });
}
