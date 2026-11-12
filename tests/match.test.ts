import { describe, expect, it } from "vitest";
import type { Book, Detection } from "../shared/types.ts";
import { bookMatchesProfile } from "../web/src/match.ts";
import type { Profile, SavedProfile } from "../web/src/profile.ts";

function detection(title: string): Detection {
  return {
    strip: 1,
    shelfRow: 1,
    position: 1,
    spineText: title,
    title,
    author: null,
    legible: true,
    confidence: 0.9,
    callNumber: null,
    sticker: null,
    box: null,
    stripCenter: null,
  };
}

function book(partial: Partial<Book> & Pick<Book, "key">): Book {
  return {
    detections: [],
    status: "done",
    canonicalTitle: null,
    authors: [],
    firstPublishedYear: null,
    primaryGenre: null,
    secondaryGenres: [],
    summary: null,
    avgRating: null,
    ratingsCount: null,
    ratingSource: null,
    ratingUrl: null,
    isbn13: null,
    flags: [],
    score: null,
    mark: "",
    box: null,
    ...partial,
  };
}

function saved(partial: Partial<SavedProfile> = {}): Profile {
  return { status: "saved", name: "Ada", genres: [], picks: [], ...partial };
}

describe("profile match", () => {
  it("matches a chosen genre on the primary or a secondary genre", () => {
    const profile = saved({ genres: ["fantasy"] });
    expect(bookMatchesProfile(book({ key: "a", primaryGenre: "fantasy" }), profile)).toBe(true);
    expect(bookMatchesProfile(book({ key: "b", primaryGenre: "history", secondaryGenres: ["fantasy"] }), profile)).toBe(true);
    expect(bookMatchesProfile(book({ key: "c", primaryGenre: "history" }), profile)).toBe(false);
  });

  it("matches the preferred quiz title and ignores the title that was passed over", () => {
    const profile = saved({ picks: [{ prefer: "The Hobbit", over: "Dune" }] });
    expect(bookMatchesProfile(book({ key: "hobbit", canonicalTitle: "The Hobbit, or There and Back Again" }), profile)).toBe(true);
    expect(bookMatchesProfile(book({ key: "dune", canonicalTitle: "Dune" }), profile)).toBe(false);
    expect(bookMatchesProfile(book({ key: "child", canonicalTitle: "Children of Dune" }), saved({ picks: [{ prefer: "Dune", over: "The Hobbit" }] }))).toBe(false);
  });

  it("does not treat a missing canonical title as a match", () => {
    const profile = saved({ picks: [{ prefer: "The Hobbit", over: "Dune" }] });
    expect(bookMatchesProfile(book({ key: "blank", canonicalTitle: null }), profile)).toBe(false);
    expect(bookMatchesProfile(book({ key: "spine", canonicalTitle: null, detections: [detection("The Hobbit")] }), profile)).toBe(true);
    expect(bookMatchesProfile(book({ key: "other", canonicalTitle: null, detections: [detection("Dune")] }), profile)).toBe(false);
  });

  it("matches nothing when the profile was skipped or has not been saved", () => {
    const hobbit = book({ key: "hobbit", canonicalTitle: "The Hobbit", primaryGenre: "fantasy" });
    expect(bookMatchesProfile(hobbit, { status: "skipped" })).toBe(false);
    expect(bookMatchesProfile(hobbit, null)).toBe(false);
    expect(bookMatchesProfile(hobbit, undefined)).toBe(false);
  });
});
