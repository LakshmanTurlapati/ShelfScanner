import type { Book } from "../../shared/types.ts";
import { coverImageUrl } from "./covers";
import { bookMatchesProfile } from "./match";
import type { Profile } from "./profile";

function finitePin(pin: Book["pin"]): pin is { x: number; row: number } {
  return Boolean(pin) && typeof pin!.x === "number" && Number.isFinite(pin!.x) && typeof pin!.row === "number" && Number.isFinite(pin!.row);
}

export function walkOrder(books: readonly Book[]) {
  return books
    .map((book, index) => ({ book, index }))
    .sort((a, b) => {
      const rowA = finitePin(a.book.pin) ? a.book.pin.row : Number.POSITIVE_INFINITY;
      const rowB = finitePin(b.book.pin) ? b.book.pin.row : Number.POSITIVE_INFINITY;
      if (rowA !== rowB) return rowA - rowB;
      const xA = finitePin(a.book.pin) ? a.book.pin.x : Number.POSITIVE_INFINITY;
      const xB = finitePin(b.book.pin) ? b.book.pin.x : Number.POSITIVE_INFINITY;
      if (xA !== xB) return xA - xB;
      return a.index - b.index;
    })
    .map((item) => item.book);
}

export function bookTitle(book: Book) {
  return book.canonicalTitle ?? book.detections[0]?.title ?? "Unread spine";
}

export function CoverGrid({ books, onOpen, profile = null }: { books: Book[]; onOpen: (book: Book) => void; profile?: Profile | null }) {
  return (
    <ul className="grid grid-cols-3 gap-2">
      {walkOrder(books).map((book) => {
        const title = bookTitle(book);
        const src = coverImageUrl(book.coverId);
        const author = book.authors[0] ?? "Author unknown";
        const forYou = bookMatchesProfile(book, profile);
        return (
          <li key={book.key}>
            <button className={`w-full rounded-lg text-left ${forYou ? "ring-2 ring-[#7c3aed]" : ""}`} type="button" onClick={() => onOpen(book)} aria-label={`Cover of ${title}`}>
              {src ? (
                <img className="aspect-[2/3] w-full rounded-lg object-cover" src={src} alt="" />
              ) : (
                <span className="flex aspect-[2/3] w-full items-end rounded-lg bg-[#f1ebe4] p-2 text-sm">{title}</span>
              )}
              {forYou && <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-[#7c3aed]">For you</p>}
              <h2 className="mt-2 text-sm leading-5">{title}</h2>
              <p className="text-xs text-[#6a584d]">{author}</p>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
