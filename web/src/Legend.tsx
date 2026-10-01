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
      <span className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#ff6b35] text-xs font-semibold text-[#1f1a17]">{book.mark || "·"}</span>
      <span className="min-w-0 flex-1 truncate">{titleOf(book)}</span>
      <span className="text-sm text-[#6a584d]">{rating}</span>
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
          <h2 className="mono mb-2 text-xs uppercase tracking-[0.06em] text-[#6a584d]">Top rated</h2>
          <ul className="space-y-2">
            {rated.map((book) => (
              <LegendRow key={`rated-${book.key}`} book={book} />
            ))}
          </ul>
        </section>
      )}
      <section>
        <h2 className="mono mb-2 text-xs uppercase tracking-[0.06em] text-[#6a584d]">On this shelf</h2>
        <ul className="space-y-2">
          {reading.map((book) => (
            <LegendRow key={book.key} book={book} />
          ))}
        </ul>
      </section>
    </div>
  );
}
