import { z } from "zod";
import { GENRES } from "./types.ts";

export const Spine = z.strictObject({
  shelf_row: z.int().min(1),
  position: z.int().min(1),
  spine_text: z.string(),
  title: z.string(),
  author: z.string().nullable(),
  legible: z.boolean(),
  confidence: z.number().min(0).max(1),
  call_number: z.string().nullable(),
  sticker: z.string().nullable(),
});

export const Spines = z.strictObject({ spines: z.array(Spine) });

export const BookFacts = z.strictObject({
  matched: z.boolean(),
  match_confidence: z.number().min(0).max(1),
  canonical_title: z.string().nullable(),
  authors: z.array(z.string()),
  first_published_year: z.int().nullable(),
  primary_genre: z.enum(GENRES).nullable(),
  secondary_genres: z.array(z.enum(GENRES)).max(2),
  summary: z.string().nullable(),
  avg_rating: z.number().min(1).max(5).nullable(),
  ratings_count: z.int().min(0).nullable(),
  rating_source: z.enum(["goodreads", "google_books", "open_library", "other"]).nullable(),
  rating_url: z.string().nullable(),
  isbn13: z.string().nullable(),
});

export type SpineInput = z.infer<typeof Spine>;
export type BookFactsInput = z.infer<typeof BookFacts>;

function asObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...schema };
  if (copy.type === "object") {
    copy.additionalProperties = false;
  }
  if (copy.properties && typeof copy.properties === "object") {
    const properties = copy.properties as Record<string, Record<string, unknown>>;
    copy.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, asObjectSchema(value)]),
    );
  }
  if (copy.items && typeof copy.items === "object") {
    copy.items = asObjectSchema(copy.items as Record<string, unknown>);
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(copy[key])) {
      copy[key] = (copy[key] as Record<string, unknown>[]).map((entry) => asObjectSchema(entry));
    }
  }
  return copy;
}

export function responseSchema(type: z.ZodType) {
  return asObjectSchema(z.toJSONSchema(type) as Record<string, unknown>);
}

export const SPINES_JSON_SCHEMA = responseSchema(Spines);
export const BOOK_JSON_SCHEMA = responseSchema(BookFacts);
