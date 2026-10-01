export const GENRES = [
  "literary_fiction",
  "mystery_thriller",
  "science_fiction",
  "fantasy",
  "romance",
  "horror",
  "historical_fiction",
  "young_adult",
  "childrens",
  "biography_memoir",
  "history",
  "science_nature",
  "business_economics",
  "self_help_psychology",
  "philosophy_religion",
  "poetry_drama",
  "comics_graphic",
  "reference",
  "other",
] as const;

export type Genre = (typeof GENRES)[number];

export type Flag = "unverified_rating" | "possible_mismatch" | "bad_isbn";

export type NormBox = { x: number; y: number; w: number; h: number };

export type Detection = {
  /** A physical spine in one captured photo, independent of its book identity. */
  id?: string;
  captureId?: string;
  photoIndex?: number;
  placement?: "matched" | "unmatched-text" | "unmatched-box" | "ambiguous";
  strip: number;
  shelfRow: number;
  position: number;
  spineText: string;
  title: string;
  author: string | null;
  legible: boolean;
  confidence: number;
  callNumber: string | null;
  sticker: string | null;
  box: NormBox | null;
  stripCenter: number | null;
  /** Left and right edges of the box within its strip, 0 to 1. */
  stripSpan?: [number, number] | null;
};

export type Book = {
  key: string;
  detections: Detection[];
  status: "queued" | "enriching" | "done" | "unmatched" | "error";
  canonicalTitle: string | null;
  authors: string[];
  firstPublishedYear: number | null;
  primaryGenre: Genre | null;
  secondaryGenres: Genre[];
  summary: string | null;
  avgRating: number | null;
  ratingsCount: number | null;
  ratingSource: "goodreads" | "google_books" | "open_library" | "other" | null;
  ratingUrl: string | null;
  isbn13: string | null;
  flags: Flag[];
  score: number | null;
  mark: string;
  box: NormBox | null;
  embedding?: number[];
  error?: string;
};

export type Session = {
  id: string;
  createdAt: string;
  photoCount: number;
  books: Book[];
};

export const GENRE_LABELS: Record<Genre, string> = {
  literary_fiction: "Literary fiction",
  mystery_thriller: "Mystery & thriller",
  science_fiction: "Science fiction",
  fantasy: "Fantasy",
  romance: "Romance",
  horror: "Horror",
  historical_fiction: "Historical fiction",
  young_adult: "Young adult",
  childrens: "Children's",
  biography_memoir: "Biography & memoir",
  history: "History",
  science_nature: "Science & nature",
  business_economics: "Business & economics",
  self_help_psychology: "Self-help & psychology",
  philosophy_religion: "Philosophy & religion",
  poetry_drama: "Poetry & drama",
  comics_graphic: "Comics & graphic",
  reference: "Reference",
  other: "Other",
};
