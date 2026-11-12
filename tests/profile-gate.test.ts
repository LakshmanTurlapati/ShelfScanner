import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GENRE_LABELS } from "../shared/types.ts";
import { ProfileGate } from "../web/src/ProfileGate.tsx";
import { picksFrom, QUIZ_PAIRS } from "../web/src/quiz.ts";

describe("profile screen", () => {
  it("offers a name, every genre, five book pairs, and a skip", () => {
    const html = renderToStaticMarkup(createElement(ProfileGate, { onDone: () => undefined })).replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
    expect(html).toContain("Who is this shelf for?");
    expect(html).toContain("This stays on this phone.");
    expect(html).toContain("Skip for now");
    expect(html).toContain("Save profile");
    expect(html).toContain("Name");
    for (const label of Object.values(GENRE_LABELS)) expect(html).toContain(label);
    for (const pair of QUIZ_PAIRS) {
      expect(html).toContain(pair[0]);
      expect(html).toContain(pair[1]);
    }
    expect(QUIZ_PAIRS).toHaveLength(5);
  });

  it("keeps only a chosen side of a pair", () => {
    expect(picksFrom(["Dune", undefined, undefined, "Beloved", "Neither"])).toEqual([
      { prefer: "Dune", over: "The Hobbit" },
      { prefer: "Beloved", over: "The Road" },
    ]);
  });

  it("does not send the profile anywhere", () => {
    const gate = readFileSync(new URL("../web/src/ProfileGate.tsx", import.meta.url), "utf8");
    const app = readFileSync(new URL("../web/src/App.tsx", import.meta.url), "utf8");
    expect(gate).not.toMatch(/fetch\s*\(|\/api\//);
    expect(app).toContain("loadProfile");
    expect(app).toContain("<ProfileGate");
  });
});
