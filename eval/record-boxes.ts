import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MODELS } from "../shared/models.ts";
import { openrouter } from "../server/openrouter.ts";
import { parsePointBoxes } from "../server/pair-spines.ts";
import { readPrompt } from "../server/prompts.ts";

const fixture = process.argv[2];
if (!fixture) throw new Error("Pass a golden fixture name.");
if (!process.env.OPENROUTER_API_KEY) throw new Error("Set OPENROUTER_API_KEY before recording.");
const fixturePath = path.resolve("eval/golden", `${fixture}.json`);
const { image } = JSON.parse(readFileSync(fixturePath, "utf8")) as { image: string };
const photo = readFileSync(path.resolve("eval/golden", image));
const response = await openrouter("/chat/completions", {
  model: MODELS.boxes,
  messages: [
    { role: "system", content: readPrompt("boxes.md") },
    { role: "user", content: [
      { type: "text", text: "Mark every book spine." },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${photo.toString("base64")}` } },
    ] },
  ],
  vision_config: { annotation_format: "box", enable_thinking: false },
});
const content = response?.choices?.[0]?.message?.content;
const raw = typeof content === "string" ? content : JSON.stringify(content ?? "");
const boxes = parsePointBoxes(raw);
const output = path.resolve("eval/results", `${fixture}.boxes.json`);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify({ response, boxes }, null, 2));
console.log(`Recorded ${boxes.length} box annotations in ${output}`);
if (!boxes.length) throw new Error("The model response contained no parseable point_box annotations.");
