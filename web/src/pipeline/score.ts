import type { Book, Genre } from "../../../shared/types.ts";

export const PRIOR = { C: 3.9, m: 1000 };

export function score(b: Book, { C, m } = PRIOR): number | null {
  if (b.avgRating == null || b.ratingsCount == null) return null;
  const v = b.ratingsCount;
  return (v / (v + m)) * b.avgRating + (m / (v + m)) * C;
}

const byScore = (a: Book, b: Book) =>
  b.score! - a.score! ||
  (b.ratingsCount ?? 0) - (a.ratingsCount ?? 0) ||
  (a.canonicalTitle ?? "").localeCompare(b.canonicalTitle ?? "");

export function withScores(books: Book[]): Book[] {
  return books.map((b) => ({ ...b, score: score(b) }));
}

export function topRated(books: Book[]) {
  const rated = books.filter((b) => b.score != null);
  return {
    goodreads: rated.filter((b) => b.ratingSource === "goodreads").sort(byScore),
    elsewhere: rated.filter((b) => b.ratingSource && b.ratingSource !== "goodreads").sort(byScore),
    unrated: books
      .filter((b) => b.score == null)
      .sort((a, b) => (a.canonicalTitle ?? a.key).localeCompare(b.canonicalTitle ?? b.key)),
  };
}

export type GenreSection = {
  genre: Genre;
  best: Book | null;
  books: Book[];
  mean: number | null;
  ratedCount: number;
};

export function genreSections(books: Book[]): GenreSection[] {
  const labeled = books.filter((b) => b.primaryGenre);
  const counts = new Map<Genre, number>();
  for (const book of labeled) {
    const genre = book.primaryGenre!;
    counts.set(genre, (counts.get(genre) ?? 0) + 1);
  }
  let dominant = 0;
  for (const count of counts.values()) dominant = Math.max(dominant, count);
  const useSecondary = labeled.length > 0 && dominant / labeled.length > 0.7;

  const groups = new Map<Genre, Book[]>();
  for (const book of books) {
    const genre = useSecondary
      ? (book.secondaryGenres[0] ?? book.primaryGenre)
      : book.primaryGenre;
    if (!genre) continue;
    const list = groups.get(genre) ?? [];
    list.push(book);
    groups.set(genre, list);
  }

  return [...groups]
    .map(([genre, list]) => {
      const rated = list.filter((b) => b.score != null).sort(byScore);
      const mean = rated.length ? rated.reduce((sum, b) => sum + b.score!, 0) / rated.length : null;
      return { genre, best: rated[0] ?? null, books: list, mean, ratedCount: rated.length };
    })
    .sort(
      (a, b) =>
        Number(b.ratedCount >= 2) - Number(a.ratedCount >= 2) || (b.mean ?? 0) - (a.mean ?? 0),
    );
}
