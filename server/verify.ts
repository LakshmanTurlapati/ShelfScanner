import { token_set_ratio } from "fuzzball";
import type { BookFactsInput } from "../shared/schemas.ts";
import { GENRES, type Flag } from "../shared/types.ts";
import { norm } from "../web/src/pipeline/dedup.ts";

export type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
    };
  }>;
  usage?: SearchUsage;
};

export type SearchUsage = {
  server_tool_use?: { web_search_requests?: number };
  server_tool_use_details?: { web_search_requests?: number };
};

export function searchCount(usage: SearchUsage | undefined) {
  return (usage?.server_tool_use_details ?? usage?.server_tool_use)?.web_search_requests ?? 0;
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const genre = (value: unknown) => (GENRES as readonly unknown[]).includes(value) ? (value as (typeof GENRES)[number]) : null;

function ratingSource(url: string | null) {
  if (!url) return null;
  const host = url.replace(/^https?:\/\/(www\.)?/, "");
  if (host.startsWith("goodreads.com")) return "goodreads" as const;
  if (host.startsWith("books.google.")) return "google_books" as const;
  if (host.startsWith("openlibrary.org")) return "open_library" as const;
  return "other" as const;
}

// With the web search tool on, the model does not follow the response schema,
// so its answer is mapped onto BookFacts field by field.
export function normalizeFacts(raw: unknown): BookFactsInput | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const matched = r.matched === true;
  const authors = Array.isArray(r.authors)
    ? r.authors.map(text).filter((a): a is string => a !== null)
    : (text(r.author)?.split(/\s+(?:and|&)\s+/) ?? []);
  const primary = genre(r.primary_genre);
  const rating = typeof r.avg_rating === "number" && r.avg_rating >= 1 && r.avg_rating <= 5 ? r.avg_rating : null;
  const count = typeof r.ratings_count === "number" && Number.isInteger(r.ratings_count) && r.ratings_count >= 0 ? r.ratings_count : null;
  const url = rating === null ? null : text(r.rating_url);
  const year = typeof r.first_published_year === "number" && Number.isInteger(r.first_published_year) ? r.first_published_year : null;
  const confidence = typeof r.match_confidence === "number" ? Math.min(1, Math.max(0, r.match_confidence)) : matched ? 0.8 : 0;
  return {
    matched,
    match_confidence: confidence,
    canonical_title: text(r.canonical_title) ?? text(r.title),
    authors,
    first_published_year: year,
    primary_genre: primary,
    secondary_genres: (Array.isArray(r.secondary_genres) ? r.secondary_genres : [])
      .map(genre)
      .filter((g): g is NonNullable<typeof g> => g !== null && g !== primary)
      .slice(0, 2),
    summary: text(r.summary),
    avg_rating: rating,
    ratings_count: rating === null ? null : count,
    rating_source: (r.rating_source as BookFactsInput["rating_source"]) ?? ratingSource(url),
    rating_url: url,
    isbn13: text(r.isbn13),
  };
}

const pageKey = (u: string) => {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "");
  } catch {
    return u;
  }
};

export const isValidIsbn13 = (s: string) => {
  const d = s.replace(/\D/g, "");
  if (d.length !== 13) return false;
  return [...d].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
};

export function verify(facts: BookFactsInput, res: ChatResponse, spineTitle: string) {
  const flags: Flag[] = [];
  const cited = new Set(
    (res.choices?.[0]?.message?.annotations ?? [])
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => pageKey(a.url_citation!.url!)),
  );
  const searched = searchCount(res.usage) > 0;
  if (facts.avg_rating !== null && (!searched || !facts.rating_url || !cited.has(pageKey(facts.rating_url)))) {
    facts.avg_rating = null;
    facts.ratings_count = null;
    flags.push("unverified_rating");
  }
  if (facts.isbn13 && !isValidIsbn13(facts.isbn13)) {
    facts.isbn13 = null;
    flags.push("bad_isbn");
  }
  if (facts.canonical_title && token_set_ratio(norm(facts.canonical_title), norm(spineTitle)) < 70) {
    flags.push("possible_mismatch");
  }
  return { facts, flags };
}
