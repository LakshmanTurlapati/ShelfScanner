// Renders the Google Play listing art into docs/store:
//   feature-graphic.png        1024 x 500
//   phone-N-<name>.png         1080 x 1920 (9:16), a caption over a capture of the real UI
//
// The phone captures come from the running web app (the same UI the Android app wraps) with a
// demo shelf of public domain classics, so no third-party cover art or invented spine labels
// end up in the listing. Their ratings are rounded demo values, not live lookups.
// The live camera view needs a real shelf, so take that capture on a phone and frame it:
//
//   npm run store:assets
//   npm run store:assets -- --frame ~/Desktop/live.png "Point at a shelf. Titles stay on their spines."
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const OUT = path.resolve("docs/store");
const PHONE = { width: 1080, height: 1920 };
const FEATURE = { width: 1024, height: 500 };

const dataUrl = (file, type) => `data:${type};base64,${readFileSync(file).toString("base64")}`;
const font = (pkg, weight) => dataUrl(path.resolve(`node_modules/@fontsource/${pkg}/files/${pkg}-latin-${weight}-normal.woff2`), "font/woff2");
const FONTS = `
  @font-face { font-family: Outfit; font-weight: 400; src: url(${font("outfit", 400)}) format("woff2"); }
  @font-face { font-family: Outfit; font-weight: 600; src: url(${font("outfit", 600)}) format("woff2"); }
  @font-face { font-family: "Space Mono"; font-weight: 400; src: url(${font("space-mono", 400)}) format("woff2"); }
`;
const LOGO = dataUrl(path.resolve("web/public/logo.svg"), "image/svg+xml");

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// [title, author, primary genre, secondary genres, demo rating, demo rating count, one line summary]
const CLASSICS = [
  ["The Adventures of Sherlock Holmes", "Arthur Conan Doyle", "mystery_thriller", [], 4.3, 310_000, "Twelve short cases, each one solved from details everyone else walked past."],
  ["Pride and Prejudice", "Jane Austen", "romance", ["literary_fiction"], 4.3, 4_400_000, "Elizabeth Bennet and Mr Darcy misjudge each other, sharply and very funnily."],
  ["Frankenstein", "Mary Shelley", "horror", ["science_fiction"], 3.9, 1_700_000, "A young scientist builds a living man and spends the rest of the book running from it."],
  ["The Time Machine", "H. G. Wells", "science_fiction", [], 3.9, 520_000, "A Victorian inventor travels to the year 802,701 and does not like what he finds."],
  ["Alice's Adventures in Wonderland", "Lewis Carroll", "fantasy", ["childrens"], 4.0, 600_000, "A girl follows a rabbit underground into a world that runs on nonsense."],
  ["Dracula", "Bram Stoker", "horror", [], 4.0, 1_300_000, "Letters and diaries track a Transylvanian count as he moves to London."],
  ["The War of the Worlds", "H. G. Wells", "science_fiction", [], 3.8, 300_000, "Martian cylinders land in Surrey, and the narrator tries to get home alive."],
  ["The Wonderful Wizard of Oz", "L. Frank Baum", "fantasy", ["childrens"], 4.0, 450_000, "Dorothy and three new friends walk the yellow brick road to the Emerald City."],
  ["Jane Eyre", "Charlotte Brontë", "literary_fiction", ["romance"], 4.2, 2_100_000, "An orphan becomes a governess and will not give up her independence for anyone."],
];

const ANSWER = [
  "- **The Adventures of Sherlock Holmes** by Arthur Conan Doyle, 4.3. Short cases to start tonight.",
  "- **Pride and Prejudice** by Jane Austen, 4.3. The best rated novel here.",
  "- **The Time Machine** by H. G. Wells, 3.9. Fits your science fiction picks.",
  "",
].join("\n");

function demoBook([title, author, genre, secondary, rating, count, summary], index) {
  return {
    key: title.toLowerCase(),
    detections: [{ shelfRow: 1, position: index + 1, strip: 1, spineText: title, title, author, legible: true, confidence: 0.95, callNumber: null, sticker: null, box: null, stripCenter: null }],
    status: "done",
    canonicalTitle: title,
    authors: [author],
    firstPublishedYear: null,
    primaryGenre: genre,
    secondaryGenres: secondary,
    summary,
    avgRating: rating,
    ratingsCount: count,
    ratingSource: "goodreads",
    ratingUrl: null,
    isbn13: null,
    flags: [],
    score: null,
    mark: String.fromCharCode(65 + index),
    box: null,
    coverId: null,
    coverUrl: null,
  };
}

function framePage(image, caption) {
  return `<!doctype html><html><head><style>${FONTS}
    html, body { margin: 0; width: ${PHONE.width}px; height: ${PHONE.height}px; overflow: hidden; }
    body { background: radial-gradient(120% 70% at 50% 0%, #2a211d 0%, #141110 60%); display: flex; flex-direction: column; align-items: center; }
    h1 { font: 600 66px/1.12 Outfit, sans-serif; color: #fffaf6; text-align: center; margin: 120px 90px 0; letter-spacing: -0.01em; }
    .bar { width: 72px; height: 8px; border-radius: 4px; background: #ff6b35; margin: 36px 0 56px; }
    img { max-width: 760px; max-height: ${PHONE.height - 120 - 300}px; border-radius: 44px; box-shadow: 0 30px 80px rgba(0,0,0,0.55); border: 6px solid #2c2420; }
  </style></head><body><h1>${escape(caption)}</h1><div class="bar"></div><img src="${image}"></body></html>`;
}

function featurePage() {
  return `<!doctype html><html><head><style>${FONTS}
    html, body { margin: 0; width: ${FEATURE.width}px; height: ${FEATURE.height}px; overflow: hidden; }
    body { background: radial-gradient(90% 120% at 15% 50%, #2e241f 0%, #141110 65%); display: flex; align-items: center; gap: 56px; padding: 0 84px; box-sizing: border-box; }
    img { width: 230px; height: 230px; flex: none; }
    h1 { font: 600 76px/1 Outfit, sans-serif; color: #fffaf6; margin: 0 0 22px; letter-spacing: -0.015em; }
    p { font: 400 30px/1.35 Outfit, sans-serif; color: #d9cbbf; margin: 0; max-width: 560px; }
    .bar { width: 64px; height: 7px; border-radius: 4px; background: #ff6b35; margin: 0 0 26px; }
  </style></head><body><img src="${LOGO}"><div><div class="bar"></div><h1>Shelf Scanner</h1><p>Point at a shelf. See the titles, the ratings, and the book that fits you.</p></div></body></html>`;
}

async function render(browser, html, size, file) {
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file });
  await page.close();
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}

async function captureApp(browser) {
  const server = await createServer({ configFile: path.resolve("vite.config.ts"), server: { port: 5199, strictPort: false }, logLevel: "error" });
  await server.listen();
  const base = server.resolvedUrls.local[0];
  const context = await browser.newContext({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await context.addInitScript(() => {
    localStorage.setItem("shelf-scanner-data-notice", "1");
    localStorage.setItem("shelf-scanner-auto-read", "off");
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => Promise.reject(new Error("no camera")) } });
  });
  // Nothing in a capture reaches the real server or a cover site. The last matching route wins,
  // so the catch-all goes first.
  await context.route("**/api/**", (route) => route.fulfill({ status: 204 }));
  await context.route("**/api/ask", (route) => route.fulfill({ status: 200, contentType: "text/plain", body: ANSWER }));
  await context.route(/openlibrary\.org|googleapis\.com|books\.google/, (route) => route.abort());
  const page = await context.newPage();
  const shots = [];
  try {
    await page.goto(base);
    const books = CLASSICS.map(demoBook);
    await page.evaluate(async (books) => {
      const profilePath = "/src/profile.ts";
      const storePath = "/src/store.ts";
      const { saveProfile } = await import(profilePath);
      const { useShelf } = await import(storePath);
      await saveProfile({ name: "Sam", genres: ["science_fiction", "fantasy"], picks: [] });
      const id = useShelf.getState().beginSession(1, "store-demo", "still");
      useShelf.getState().setBooksFor(id, books);
    }, books);
    await page.waitForTimeout(800); // one persist interval, so the reload finds the shelf
    await page.reload();
    await page.getByRole("status", { name: "Shelf Scanner is starting" }).waitFor({ state: "detached", timeout: 8000 });
    await page.getByRole("button", { name: "Open Shelf" }).click();
    await page.getByRole("button", { name: /Cover of Frankenstein/ }).waitFor();
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.getByRole("tab", { name: "Shelf" }).click();
    await page.evaluate(() => {
      const first = [...document.querySelectorAll("button")].find((node) => node.getAttribute("aria-label")?.startsWith("Cover of"));
      first?.scrollIntoView({ block: "start" });
      window.scrollBy(0, -6);
    });
    shots.push({ name: "covers", caption: "Every book on the shelf, with the ones for you marked", image: await page.screenshot() });

    await page.getByRole("tab", { name: "Top Rated" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    shots.push({ name: "top-rated", caption: "See which books are rated best", image: await page.screenshot() });

    await page.getByRole("tab", { name: "Shelf" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByLabel("Ask the shelf").fill("What should I read first?");
    await page.getByRole("button", { name: "Ask", exact: true }).click();
    await page.getByRole("button", { name: "Report this answer" }).waitFor();
    // The chat follows the newest line; start it at the question so the shot shows both.
    await page.evaluate(() => {
      const chat = document.querySelector(".overflow-y-auto");
      if (chat) chat.scrollTop = 0;
    });
    shots.push({ name: "ask", caption: "Ask the shelf what to read next", image: await page.screenshot() });
  } finally {
    await context.close();
    await server.close();
  }
  return shots;
}

const args = process.argv.slice(2);
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
try {
  if (args[0] === "--frame") {
    const [, file, caption] = args;
    if (!file || !caption) throw new Error('Usage: npm run store:assets -- --frame <capture.png> "Caption"');
    const name = path.basename(file, path.extname(file)).replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    await render(browser, framePage(dataUrl(path.resolve(file), "image/png"), caption), PHONE, path.join(OUT, `phone-0-${name}.png`));
  } else {
    await render(browser, featurePage(), FEATURE, path.join(OUT, "feature-graphic.png"));
    const shots = await captureApp(browser);
    for (const [index, shot] of shots.entries()) {
      const image = `data:image/png;base64,${shot.image.toString("base64")}`;
      await render(browser, framePage(image, shot.caption), PHONE, path.join(OUT, `phone-${index + 1}-${shot.name}.png`));
    }
  }
} finally {
  await browser.close();
}
