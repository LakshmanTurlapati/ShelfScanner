import type { Book } from "../../shared/types.ts";
import { sameTitle } from "./overlay/anchors.ts";
import type { Profile } from "./profile.ts";

// A saved profile matches a book by a chosen genre, or by a quiz title the person preferred.
// The title they passed over does not count. A skipped or missing profile matches nothing.
export function bookMatchesProfile(book: Book, profile: Profile | null | undefined) {
  if (!profile || profile.status !== "saved") return false;
  const genres = [book.primaryGenre, ...book.secondaryGenres];
  if (genres.some((genre) => genre != null && profile.genres.includes(genre))) return true;
  const canonical = book.canonicalTitle?.trim();
  if (canonical) return profile.picks.some((pick) => sameTitle(canonical, pick.prefer));
  return profile.picks.some((pick) => book.detections.some((detection) => sameTitle(detection.title, pick.prefer)));
}
