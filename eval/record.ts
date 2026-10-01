import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import type { Book } from "../shared/types.ts";

const fixture = process.argv[2];
if (!fixture) throw new Error("Pass a golden fixture name, for example: npm run eval:record -- crai-spines-17");
const fixturePath = path.resolve("eval/golden", `${fixture}.json`);
const { image } = JSON.parse(readFileSync(fixturePath, "utf8")) as { image: string };
const golden = path.resolve("eval/golden", image);
const url = process.env.EVAL_APP_URL ?? "http://127.0.0.1:5173";
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(url);
  await page.getByRole("button", { name: "Live view on" }).click();
  await page.getByLabel("Shelf photo").setInputFiles(golden);
  await page.waitForFunction(async () => {
    const modulePath = "/src/store.ts";
    const { useShelf } = await import(modulePath);
    const state = useShelf.getState();
    return state.sessions.some((session: { id: string; books: Book[] }) => session.id === state.currentId && session.books.length > 0);
  }, undefined, { timeout: 120_000 });
  await page.waitForFunction(async () => {
    const modulePath = "/src/store.ts";
    const { useShelf } = await import(modulePath);
    const state = useShelf.getState();
    const session = state.sessions.find((item: { id: string }) => item.id === state.currentId);
    return session?.books.every((book: Book) => book.status !== "queued" && book.status !== "enriching") && !state.progress;
  }, undefined, { timeout: 120_000 });
  const predictions = await page.evaluate(async () => {
    const modulePath = "/src/store.ts";
    const { useShelf } = await import(modulePath);
    const anchorsPath = "/src/overlay/anchors.ts";
    const { anchorsForCapture } = await import(anchorsPath);
    const state = useShelf.getState();
    const session = state.sessions.find((item: { id: string }) => item.id === state.currentId);
    const anchors = new Set(anchorsForCapture(session?.books ?? [], session?.id ?? "").map((anchor: { id: string }) => anchor.id));
    return (session?.books ?? []).flatMap((book: Book) =>
      book.detections.map((detection) => ({
        title: detection.title,
        box: detection.box,
        placement: detection.placement ?? "unmatched-text",
        shown: anchors.has(detection.id ?? ""),
      })),
    );
  });
  const resultDir = path.resolve("eval/results");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(path.join(resultDir, `${fixture}.json`), JSON.stringify({ image: path.basename(golden), predictions }, null, 2));
  console.log(`Recorded ${predictions.length} spine detections from ${fixture}.`);
} finally {
  await browser.close();
}
