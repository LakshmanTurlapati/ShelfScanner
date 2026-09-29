import { expect, test } from "@playwright/test";

const spine = {
  shelf_row: 1,
  position: 1,
  spine_text: "THE HOBBIT TOLKIEN",
  title: "The Hobbit",
  author: "Tolkien",
  legible: true,
  confidence: 0.92,
  call_number: null,
  sticker: null,
};

test("a recorded scan fills all four tabs", async ({ page }) => {
  await page.route("**/api/read-strip**", (route) => route.fulfill({ json: { spines: [spine] } }));
  await page.route("**/api/enrich", (route) =>
    route.fulfill({
      json: {
        cached: true,
        flags: [],
        facts: {
          matched: true,
          match_confidence: 0.95,
          canonical_title: "The Hobbit",
          authors: ["J.R.R. Tolkien"],
          first_published_year: 1937,
          primary_genre: "fantasy",
          secondary_genres: [],
          summary: "A homebody joins a company of dwarves.",
          avg_rating: 4.3,
          ratings_count: 250000,
          rating_source: "goodreads",
          rating_url: "https://www.goodreads.com/book/show/5907",
          isbn13: "9780547928227",
        },
      },
    }),
  );
  await page.route("**/api/embed", (route) =>
    route.fulfill({
      json: { items: [{ key: "hobbit|tolkien", embedding: [1, 0, 0] }] },
    }),
  );

  await page.goto("/");
  await page.getByRole("button", { name: "Live view on" }).click();
  await page.getByLabel("Shelf photo").setInputFiles("tests/e2e/fixture.jpg");

  await expect(page.getByRole("heading", { name: "The Hobbit" })).toBeVisible();
  await page.getByRole("tab", { name: "Top Rated" }).click();
  await expect(page.getByRole("heading", { name: "Goodreads" })).toBeVisible();
  await page.getByRole("tab", { name: "Genres" }).click();
  await expect(page.getByRole("heading", { name: "Strongest genres on this shelf" })).toBeVisible();
  await page.getByRole("tab", { name: "Map" }).click();
  await expect(page.getByRole("heading", { name: "Nearest neighbors" })).toBeVisible();
});
