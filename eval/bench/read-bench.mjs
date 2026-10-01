import { appendFileSync, readFileSync } from "node:fs";
const ROOT = "/data/bench", PROMPTS = "/app/dist/server/prompts";
const [name, repsArg = "10"] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(`${ROOT}/manifest.json`, "utf8"));
const read = readFileSync(`${ROOT}/read.md`, "utf8");
const boxes = readFileSync(`${PROMPTS}/boxes.md`, "utf8");
const spines = readFileSync(`${PROMPTS}/spines.md`, "utf8");
const user = (text, url) => ({ role: "user", content: [{ type: "text", text }, { type: "image_url", image_url: { url } }] });
const lines = (model, extra = {}) => (i, n, url) => ({ model, stream: true, max_tokens: 1200,
  reasoning: { effort: "minimal", exclude: true },
  provider: { order: ["google-ai-studio", "google-vertex/global"], allow_fallbacks: true },
  messages: [{ role: "system", content: read }, user(`Strip ${i} of ${n}.`, url)], ...extra });
const perceptron = (cap) => (i, n, url) => ({ model: "perceptron/perceptron-mk1.5", stream: true, max_tokens: cap,
  vision_config: { annotation_format: "box", enable_thinking: false },
  messages: [{ role: "system", content: boxes }, user(`Strip ${i} of ${n}. Mark every book spine.`, url)] });
const qwen = (i, n, url) => ({ model: "qwen/qwen3.7-flash", stream: true, max_tokens: 3000, reasoning: { enabled: false },
  messages: [{ role: "system", content: spines }, user(`Strip ${i} of ${n}. Read every spine.`, url)] });
const CONFIGS = {
  BASE: { variant: "p2000q85", parts: { text: qwen, boxes: perceptron(3000) } },
  G35: { variant: "p1600q80", parts: { lines: lines("google/gemini-3.5-flash-lite"), boxes: perceptron(400) } },
  G31: { variant: "p1600q80", parts: { lines: lines("google/gemini-3.1-flash-lite"), boxes: perceptron(400) } },
  G35_2000: { variant: "p2000q85", parts: { lines: lines("google/gemini-3.5-flash-lite") } },
  G35_PRIO: { variant: "p1600q80", parts: { lines: lines("google/gemini-3.5-flash-lite", { service_tier: "priority" }) } },
  G31L: { variant: "p1600q80", parts: { lines: lines("google/gemini-3.1-flash-lite") } },
  G31_PRIO: { variant: "p1600q80", parts: { lines: lines("google/gemini-3.1-flash-lite", { service_tier: "priority" }) } },
};
const config = CONFIGS[name];
if (!config) throw new Error(`config must be one of ${Object.keys(CONFIGS).join(", ")}`);
const UNIT = /\|[^\n]*\n|<\/point_box>|"title"\s*:/;
async function call(body) {
  const t0 = performance.now(), ms = () => Math.round(performance.now() - t0);
  const r = { status: 0, headersMs: null, firstContentMs: null, firstUnitMs: null, doneMs: null, finish: null, provider: null, usage: null, error: null, text: "" };
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST",
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json", "X-Title": "Shelf Scanner bench" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    r.status = res.status; r.headersMs = ms();
    if (!res.ok) { r.error = (await res.text()).slice(0, 400); r.doneMs = ms(); return r; }
    const decoder = new TextDecoder(); let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true }); let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim(); if (data === "[DONE]") continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        if (j.error) r.error = JSON.stringify(j.error).slice(0, 400);
        r.provider ??= j.provider ?? null;
        const choice = j.choices?.[0], text = choice?.delta?.content;
        if (typeof text === "string" && text) {
          r.firstContentMs ??= ms(); r.text += text;
          if (r.firstUnitMs == null && UNIT.test(r.text)) r.firstUnitMs = ms();
        }
        if (choice?.finish_reason) r.finish = choice.finish_reason;
        if (j.usage) r.usage = j.usage;
      }
    }
  } catch (err) { r.error = String(err).slice(0, 400); }
  r.doneMs = ms(); return r;
}
const out = `${ROOT}/out-${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`;
for (let rep = 0; rep < Number(repsArg); rep++) {
  for (const image of manifest.images) {
    const strips = image.variants[config.variant];
    const jobs = strips.flatMap((strip, i) => {
      const url = `data:image/jpeg;base64,${readFileSync(`${ROOT}/${strip.file}`).toString("base64")}`;
      return Object.entries(config.parts).map(async ([part, make]) => ({ part, strip: i, ...(await call(make(i + 1, strips.length, url))) }));
    });
    for (const result of await Promise.all(jobs))
      appendFileSync(out, JSON.stringify({ config: name, variant: config.variant, rep, image: image.name, of: strips.length, ...result }) + "\n");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
console.log(`wrote ${out}`);
