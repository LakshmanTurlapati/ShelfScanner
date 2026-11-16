import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { shelfRecords } from "../server/routes/ask.ts";
import { renderMarkdown } from "../web/src/markdown.ts";

describe("shelf answers", () => {
  it("renders headings, lists, bold, and https links, and escapes html", () => {
    const html = renderMarkdown([
      "### Start here",
      "",
      "- **The Hobbit** by Tolkien, 4.3, a short adventure",
      "- <script>alert(1)</script>",
      "",
      "[Goodreads](https://www.goodreads.com/book)",
      "[nope](javascript:alert(1))",
    ].join("\n"));
    expect(html).toContain("<h3>Start here</h3>");
    expect(html).toContain("<li><strong>The Hobbit</strong> by Tolkien, 4.3, a short adventure</li>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('href="https://www.goodreads.com/book"');
    expect(html).not.toContain('href="javascript:');
  });

  it("leaves a half written emphasis mark as text while the answer is still streaming", () => {
    const html = renderMarkdown("- **The Hobbit", true);
    expect(html).not.toContain("<strong>");
    expect(html).toContain("**The Hobbit");
    const done = renderMarkdown("- **The Hobbit**\n", true);
    expect(done).toContain("<strong>The Hobbit</strong>");
  });

  it("asks for a short pick list and does not send shelf keys to the model", () => {
    const prompt = readFileSync(new URL("../server/prompts/ask.md", import.meta.url), "utf8");
    expect(prompt).toContain("**Title**");
    expect(prompt).toContain("rating");
    expect(prompt).not.toContain("square brackets");
    const records = shelfRecords([
      { key: "93502965-09b3-4e77-a40d-130ce0f6c4d3", canonicalTitle: "The Hobbit", authors: ["Tolkien"], avgRating: 4.3, summary: "A quest." },
    ]);
    expect(records).toEqual([{ title: "The Hobbit", authors: ["Tolkien"], genres: [], summary: "A quest.", rating: 4.3 }]);
    expect(JSON.stringify(records)).not.toContain("93502965");
  });
});
