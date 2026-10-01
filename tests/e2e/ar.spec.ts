import { expect, test, type Page } from "@playwright/test";

function spine(title: string, position: number, x: number) {
  return {
    shelf_row: 1,
    position,
    spine_text: title,
    title,
    author: "Writer",
    legible: true,
    confidence: 0.95,
    call_number: null,
    sticker: null,
    placement: "matched",
    x,
    y: 0.1,
    w: 0.12,
    h: 0.8,
  };
}

function hobbitFacts(rating: number) {
  return {
    facts: { matched: true, match_confidence: 0.95, canonical_title: "The Hobbit", authors: ["J.R.R. Tolkien"], first_published_year: 1937,
      primary_genre: "fantasy", secondary_genres: [], summary: "A journey.", avg_rating: rating, ratings_count: 1000,
      rating_source: "goodreads", rating_url: null, isbn13: null },
    flags: [],
    cached: false,
  };
}

async function noQuickFacts(page: Page) {
  await page.route("**/api/quick-facts", (route) => route.fulfill({ json: { items: [] } }));
}

test("camera denial offers the photo flow", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: () => Promise.reject(new Error("denied")) } });
  });
  await page.goto("/");
  await expect(page.getByText("The camera is unavailable. Use a shelf photo instead.")).toBeVisible();
  await page.getByRole("button", { name: "Use a shelf photo" }).click();
  await expect(page.getByLabel("Shelf photo")).toBeVisible();
});

test("a failed model read leaves no empty session", async ({ page }) => {
  await page.route("**/api/read-strip**", (route) => route.fulfill({ status: 502, body: "read failed" }));
  await page.goto("/");
  await page.getByRole("button", { name: "Live view on" }).click();
  await page.getByLabel("Shelf photo").setInputFiles("tests/e2e/fixture.jpg");
  await expect(page.getByText("The shelf could not be read. Try again.")).toBeVisible();
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator("aside li")).toHaveCount(0);
});

test("photo overlay keeps two physical copies of the same title", async ({ page }) => {
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return route.fulfill({ json: { spines: strip === 1 ? [spine("El libro español", 1, 0.15), spine("El libro español", 2, 0.5)] : [] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: {
    facts: { matched: true, match_confidence: 0.9, canonical_title: "El libro español", authors: ["Writer"], first_published_year: null,
      primary_genre: "reference", secondary_genres: [], summary: null, avg_rating: 4.2, ratings_count: 100,
      rating_source: "other", rating_url: null, isbn13: null }, flags: [], cached: false,
  } }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Live view on" }).click();
  await page.getByLabel("Shelf photo").setInputFiles("eval/golden/crai-spines-17.jpg");
  await expect(page.getByAltText("The shelf you photographed")).toBeVisible();
  await expect(page.locator('[data-testid="still-callouts"] svg g')).toHaveCount(2);
  await expect(page.locator('[data-testid="still-callouts"] li')).toHaveCount(2);
  await page.getByLabel("Shelf photo").setInputFiles("tests/e2e/fixture.jpg");
  await expect(page.locator('[data-testid="still-callouts"]')).toBeVisible();
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.locator("aside li button").nth(1).click();
  await expect(page.locator('[data-testid="still-callouts"]')).toHaveCount(0);
});

test("late scan results stay in their own session", async ({ page }) => {
  let calls = 0;
  await page.route("**/api/read-strip**", async (route) => {
    calls += 1;
    const first = calls <= 3;
    if (first) await new Promise((resolve) => setTimeout(resolve, 500));
    await route.fulfill({ json: { spines: [spine(first ? "Old Book" : "New Book", 1, 0.4)] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: {
    facts: { matched: false, match_confidence: 0, canonical_title: null, authors: [], first_published_year: null,
      primary_genre: null, secondary_genres: [], summary: null, avg_rating: null, ratings_count: null,
      rating_source: null, rating_url: null, isbn13: null }, flags: [], cached: false,
  } }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Live view on" }).click();
  const input = page.getByLabel("Shelf photo");
  await input.setInputFiles("tests/e2e/fixture.jpg");
  await input.setInputFiles("eval/golden/crai-spines-17.jpg");
  await expect(page.getByRole("heading", { name: /New Book/ })).toBeVisible();
  await page.waitForTimeout(700);
  await expect(page.getByRole("heading", { name: /Old Book/ })).toHaveCount(0);
  const sessions: { currentId: string | null; items: Array<{ id: string; title: string | undefined }> } = await page.evaluate(async () => {
    const modulePath = "/src/store.ts";
    const { useShelf } = await import(modulePath);
    const state = useShelf.getState();
    return { currentId: state.currentId, items: state.sessions.map((session: { id: string; books: Array<{ detections: Array<{ title: string }> }> }) => ({
      id: session.id,
      title: session.books[0]?.detections[0]?.title,
    })) };
  });
  expect(sessions.items).toHaveLength(2);
  expect(sessions.items.find((item) => item.id === sessions.currentId)?.title).toBe("New Book");
  expect(sessions.items.some((item) => item.title === "Old Book")).toBe(true);
});

type FakeCameraWindow = Window & { blankCamera?: boolean; movingCamera?: boolean };

async function fakeCamera(page: Page, { autoRead = false, moving = false } = {}) {
  await page.route("**/api/frames", (route) => route.fulfill({ status: 204 }));
  // Tests that tap Read shelf count requests, so a steady fake camera must not read itself first.
  if (!autoRead) await page.addInitScript(() => localStorage.setItem("shelf-scanner-auto-read", "off"));
  await page.addInitScript((moving) => {
    const canvas = document.createElement("canvas");
    const portrait = window.innerHeight > window.innerWidth;
    canvas.width = portrait ? 480 : 640;
    canvas.height = portrait ? 640 : 480;
    const ctx = canvas.getContext("2d")!;
    const camera = window as FakeCameraWindow;
    camera.blankCamera = false;
    camera.movingCamera = moving;
    let frame = 0;
    const draw = () => {
      const shift = camera.movingCamera ? (frame++ * 8) % 160 : 0;
      ctx.fillStyle = "#d9c4a0";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (camera.blankCamera) return;
      for (let i = 0; i < 12; i++) {
        const x = 10 + i * (canvas.width - 20) / 12 - shift;
        ctx.fillStyle = i % 2 ? "#6a2438" : "#244260";
        ctx.fillRect(x, 40, (canvas.width - 20) / 12 - 3, canvas.height - 80);
        ctx.fillStyle = "#f4df9b";
        ctx.font = "14px serif";
        ctx.fillText(`Book ${i}`, x + 2, 130 + i * 9);
        ctx.fillRect(x + 5, 65, 22, 2);
        ctx.fillRect(x + 5, canvas.height - 65, 22, 2);
      }
    };
    draw();
    setInterval(draw, 80);
    Object.defineProperty(navigator, "mediaDevices", { value: { getUserMedia: async () => canvas.captureStream(15) } });
  }, moving);
}

test("a scan failure after tracking loss still shows the error", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.fulfill({ status: 502, body: "read failed" });
  });
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read shelf" }).click();
  await page.evaluate(() => { (window as Window & { blankCamera?: boolean }).blankCamera = true; });
  await expect(page.getByText("Tracking lost. Read the shelf again.")).toBeVisible();
  await expect(page.getByText("The shelf could not be read. Try again.")).toBeVisible();
});

test("live title appears, gains its rating, and hides when tracking is lost", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return route.fulfill({ json: { spines: strip === 1 ? [spine("The Hobbit", 1, 0.5)] : [] } });
  });
  await page.route("**/api/enrich", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await route.fulfill({ json: {
      facts: { matched: true, match_confidence: 0.95, canonical_title: "The Hobbit", authors: ["J.R.R. Tolkien"], first_published_year: 1937,
        primary_genre: "fantasy", secondary_genres: [], summary: "A journey.", avg_rating: 4.3, ratings_count: 1000,
        rating_source: "goodreads", rating_url: null, isbn13: null }, flags: [], cached: false,
    } });
  });
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read shelf" }).click();
  const label = page.getByRole("button", { name: "Details for The Hobbit" });
  await expect(label).toBeVisible();
  await expect(label).toContainText("4.3★");
  await page.evaluate(() => { (window as Window & { blankCamera?: boolean }).blankCamera = true; });
  await expect(page.getByText("Tracking lost. Read the shelf again.")).toBeVisible();
  await expect(label).toHaveCount(0);
  await page.evaluate(() => { (window as Window & { blankCamera?: boolean }).blankCamera = false; });
  await page.waitForFunction(() => {
    const video = document.querySelector("video");
    if (!video?.videoWidth) return false;
    const probe = document.createElement("canvas");
    probe.width = probe.height = 1;
    const context = probe.getContext("2d");
    if (!context) return false;
    context.drawImage(video, 15, 100, 1, 1, 0, 0, 1, 1);
    const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
    return blue > red && blue > green;
  });
  await page.getByRole("button", { name: "Read again" }).click();
  await expect(label).toBeVisible();
});

test("camera frames are saved on read and while labels are visible", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return route.fulfill({ json: { spines: strip === 1 ? [spine("The Hobbit", 1, 0.5)] : [] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: {
    facts: { matched: true, match_confidence: 0.95, canonical_title: "The Hobbit", authors: ["J.R.R. Tolkien"], first_published_year: 1937,
      primary_genre: "fantasy", secondary_genres: [], summary: "A journey.", avg_rating: 4.3, ratings_count: 1000,
      rating_source: "goodreads", rating_url: null, isbn13: null }, flags: [], cached: false,
  } }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  const frame = (kind: string) => page.waitForRequest((request) =>
    request.url().endsWith("/api/frames") && request.postDataBuffer()!.toString("latin1").includes(`"kind":"${kind}"`));
  const read = frame("read");
  const labeled = frame("labels");
  await page.getByRole("button", { name: "Read shelf" }).click();
  const readBody = (await read).postDataBuffer()!;
  expect(readBody.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
  for (const timing of ["encodedMs", "firstLabelMs", "labelsMs", "firstRatingMs", "ratingsMs"]) expect(readBody.toString("latin1")).toContain(`"${timing}":`);
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toBeVisible();
  const body = (await labeled).postDataBuffer()!;
  expect(body.includes(Buffer.from([0xff, 0xd8, 0xff]))).toBe(true);
  expect(body.toString("latin1")).toContain('"title":"The Hobbit"');
});

test("a strip's labels appear while the other strips are still being read", async ({ page }) => {
  await fakeCamera(page);
  let release!: () => void;
  const secondStrip = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/read-strip**", async (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    if (strip === 2) await secondStrip;
    await route.fulfill({ json: { spines: strip === 1 ? [spine("The Hobbit", 1, 0.5)] : strip === 2 ? [spine("Dune", 1, 0.5)] : [] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: hobbitFacts(4.3) }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read shelf" }).click();
  const hobbit = page.getByRole("button", { name: "Details for The Hobbit" });
  await expect(hobbit).toBeVisible();
  await expect(hobbit).toHaveAttribute("data-spine-id", /:0:0:0$/);
  await expect(page.getByRole("button", { name: "Reading…" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Details for Dune" })).toHaveCount(0);
  release();
  await expect(page.getByRole("button", { name: "Details for Dune" })).toBeVisible();
  await expect(hobbit).toBeVisible();
});

test("labels from a strip that was read stay when another strip fails", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return strip === 1 ? route.fulfill({ json: { spines: [spine("The Hobbit", 1, 0.5)] } }) : route.fulfill({ status: 502, body: "spine read failed" });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: hobbitFacts(4.3) }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read shelf" }).click();
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toContainText("4.3★");
  await expect(page.getByRole("button", { name: "Read again" })).toBeVisible();
  await expect(page.getByText("The shelf could not be read. Try again.")).toHaveCount(0);
});

test("a quick rating shows on the label before the verified lookup returns", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return route.fulfill({ json: { spines: strip === 1 ? [spine("The Hobbit", 1, 0.5)] : [] } });
  });
  await page.route("**/api/quick-facts", (route) => {
    const { items } = route.request().postDataJSON() as { items: Array<{ key: string }> };
    return route.fulfill({ json: { items: items.map((item) => ({
      key: item.key,
      verified: false,
      flags: [],
      facts: { matched: true, canonical_title: "The Hobbit", authors: ["J.R.R. Tolkien"], avg_rating: 4.1, ratings_count: 5000,
        rating_source: "goodreads", rating_url: "https://www.goodreads.com/book/show/5907" },
    })) } });
  });
  let release!: () => void;
  const verified = new Promise<void>((resolve) => { release = resolve; });
  let enrichCalls = 0;
  await page.route("**/api/enrich", async (route) => {
    enrichCalls += 1;
    await verified;
    await route.fulfill({ json: hobbitFacts(4.3) });
  });
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Read shelf" }).click();
  const label = page.getByRole("button", { name: "Details for The Hobbit" });
  await expect(label).toContainText("4.1★");
  await expect.poll(() => enrichCalls).toBe(1);
  release();
  await expect(label).toContainText("4.3★");
});

test("a book the cache already verified skips the web lookup", async ({ page }) => {
  await fakeCamera(page);
  await page.route("**/api/read-strip**", (route) => {
    const strip = Number(new URL(route.request().url()).searchParams.get("strip"));
    return route.fulfill({ json: { spines: strip === 1 ? [spine("The Hobbit", 1, 0.5)] : [] } });
  });
  await page.route("**/api/quick-facts", (route) => {
    const { items } = route.request().postDataJSON() as { items: Array<{ key: string }> };
    const { facts, flags } = hobbitFacts(4.2);
    return route.fulfill({ json: { items: items.map((item) => ({ key: item.key, verified: true, facts, flags })) } });
  });
  let enrichCalls = 0;
  await page.route("**/api/enrich", (route) => {
    enrichCalls += 1;
    return route.fulfill({ json: hobbitFacts(4.3) });
  });
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await page.goto("/");
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
  const embedded = page.waitForRequest("**/api/embed");
  await page.getByRole("button", { name: "Read shelf" }).click();
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toContainText("4.2★");
  await embedded;
  expect(enrichCalls).toBe(0);
});

// Routes a one-book shelf and records each read-strip request's strip count.
async function hobbitShelf(page: Page, hold: Promise<void> = Promise.resolve()) {
  const reads: number[] = [];
  await page.route("**/api/read-strip**", async (route) => {
    const params = new URL(route.request().url()).searchParams;
    reads.push(Number(params.get("of")));
    await hold;
    await route.fulfill({ json: { spines: params.get("strip") === "1" ? [spine("The Hobbit", 1, 0.5)] : [] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: hobbitFacts(4.3) }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  return reads;
}

async function cameraPlaying(page: Page) {
  await expect.poll(() => page.locator("video").evaluate((video: HTMLVideoElement) => video.videoWidth)).toBeGreaterThan(0);
}

test("a steady camera reads the shelf without a tap", async ({ page }) => {
  await fakeCamera(page, { autoRead: true });
  await hobbitShelf(page);
  const readFrame = page.waitForRequest((request) =>
    request.url().endsWith("/api/frames") && request.postDataBuffer()!.toString("latin1").includes('"kind":"read"'));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Auto-read on" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toContainText("4.3★");
  expect((await readFrame).postDataBuffer()!.toString("latin1")).toContain('"auto":true');
});

test("a steady view that gave no labels is read again", async ({ page }) => {
  await fakeCamera(page, { autoRead: true });
  let reads = 0;
  await page.route("**/api/read-strip**", (route) => {
    const strip = new URL(route.request().url()).searchParams.get("strip");
    if (strip === "1") reads += 1;
    // The first read sees only a blurry, unlabelable spine; the next one reads it.
    const hobbit = { ...spine("The Hobbit", 1, 0.5), confidence: reads === 1 ? 0.6 : 0.95 };
    return route.fulfill({ json: { spines: strip === "1" ? [hobbit] : [] } });
  });
  await page.route("**/api/enrich", (route) => route.fulfill({ json: hobbitFacts(4.3) }));
  await page.route("**/api/embed", (route) => route.fulfill({ json: { items: [] } }));
  await noQuickFacts(page);
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toContainText("4.3★", { timeout: 10_000 });
  expect(reads).toBe(2);
});

test("a moving camera is not read until it holds still", async ({ page }) => {
  await fakeCamera(page, { autoRead: true, moving: true });
  const reads = await hobbitShelf(page);
  await page.goto("/");
  await cameraPlaying(page);
  await page.waitForTimeout(3000);
  expect(reads).toHaveLength(0);
  await page.evaluate(() => { (window as FakeCameraWindow).movingCamera = false; });
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toBeVisible();
});

test("turning Auto off stops automatic reads and is remembered", async ({ page }) => {
  await fakeCamera(page, { autoRead: true, moving: true });
  const reads = await hobbitShelf(page);
  await page.goto("/");
  await cameraPlaying(page);
  await page.getByRole("button", { name: "Auto-read on" }).click();
  await expect(page.getByRole("button", { name: "Auto-read off" })).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => { (window as FakeCameraWindow).movingCamera = false; });
  await page.waitForTimeout(3000);
  expect(reads).toHaveLength(0);
  await page.reload();
  await cameraPlaying(page);
  await page.evaluate(() => { (window as FakeCameraWindow).movingCamera = false; });
  await page.waitForTimeout(2000);
  expect(reads).toHaveLength(0);
  await page.getByRole("button", { name: "Auto-read off" }).click();
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toBeVisible();
});

test("a tap during an automatic read adopts it instead of reading twice", async ({ page }) => {
  await fakeCamera(page, { autoRead: true });
  let release!: () => void;
  const reads = await hobbitShelf(page, new Promise<void>((resolve) => { release = resolve; }));
  await page.goto("/");
  await expect.poll(() => reads.length).toBeGreaterThan(0);
  const button = page.getByRole("button", { name: "Reading…" });
  await button.click();
  await expect(button).toBeDisabled();
  release();
  await expect(page.getByRole("button", { name: "Details for The Hobbit" })).toContainText("4.3★");
  await expect(page.getByRole("button", { name: "Read again" })).toBeEnabled();
  // Long enough for another automatic read if the tracked view were not already covered.
  await page.waitForTimeout(3500);
  expect(reads).toHaveLength(reads[0]);
});

test("the splash shows on launch and then gets out of the way", async ({ page }) => {
  await fakeCamera(page);
  await page.goto("/");
  const splash = page.getByRole("status", { name: "Shelf Scanner is starting" });
  await expect(splash).toBeVisible();
  await expect(splash).toContainText("Point at a shelf. Find the best book on it.");
  await expect(splash).toContainText(/v\d+\.\d+ \| By Lakshman Turlapati/);
  await expect(page.getByRole("button", { name: "Read shelf" })).toBeVisible();
  await expect(splash).toHaveCount(0, { timeout: 4000 });
});
