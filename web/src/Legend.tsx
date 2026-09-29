import type { Book } from "../../shared/types.ts";
import { markRank } from "./overlay/geometry";

function titleOf(book: Book) {
  if (book.status === "queued" || book.status === "enriching") return book.detections[0]?.title || "Reading the spine";
  return book.canonicalTitle ?? book.detections[0]?.title ?? "Unread spine";
}

function ratingOf(book: Book) {
  if (book.status === "queued" || book.status === "enriching") return "…";
  return book.score != null ? book.score.toFixed(2) : "—";
}

function LegendRow({ book }: { book: Book }) {
  const rating = ratingOf(book);
  return (
    <li className="flex items-baseline gap-3">
      <span className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#1c1915] text-xs text-[#f3ecdf]">{book.mark || "·"}</span>
      <span className="min-w-0 flex-1 truncate">{titleOf(book)}</span>
      <span className="text-sm text-[#6d6458]">{rating}</span>
    </li>
  );
}

export function Legend({ books }: { books: Book[] }) {
  const reading = [...books].sort((a, b) => markRank(a.mark) - markRank(b.mark));
  const rated = books.filter((book) => book.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  return (
    <div className="space-y-4">
      {rated.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm uppercase tracking-wide text-[#6d6458]">Top rated</h2>
          <ul className="space-y-2">
            {rated.map((book) => (
              <LegendRow key={`rated-${book.key}`} book={book} />
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mb-2 text-sm uppercase tracking-wide text-[#6d6458]">On this shelf</h2>
        <ul className="space-y-2">
          {reading.map((book) => (
            <LegendRow key={book.key} book={book} />
          ))}
        </ul>
      </section>
    </div>
  );
}
