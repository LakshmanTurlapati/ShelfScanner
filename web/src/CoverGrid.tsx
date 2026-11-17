import type { Book } from "../../shared/types.ts";
import { CoverFace } from "./CoverFace";
import { bookMatchesProfile } from "./match";
import { finitePin, pinSection } from "./pin";
import type { Profile } from "./profile";

// A walk's books in the order it met them: shelf by shelf (New shelf), then top row to bottom,
// then left to right. Unplaced books come last.
export function walkOrder(books: readonly Book[]) {
  return books
    .map((book, index) => ({ book, index }))
    .sort((a, b) => {
      const sectionA = finitePin(a.book.pin) ? pinSection(a.book.pin) : Number.POSITIVE_INFINITY;
      const sectionB = finitePin(b.book.pin) ? pinSection(b.book.pin) : Number.POSITIVE_INFINITY;
      if (sectionA !== sectionB) return sectionA - sectionB;
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

/** Walk order split by shelf. A single shelf (or a photo) is one untitled group. */
export function shelfGroups(books: readonly Book[]) {
  const groups: { section: number | null; books: Book[] }[] = [];
  for (const book of walkOrder(books)) {
    const section = finitePin(book.pin) ? pinSection(book.pin) : null;
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.books.push(book);
    else groups.push({ section, books: [book] });
  }
  return groups.filter((group) => group.section !== null).length > 1 ? groups : [{ section: null, books: groups.flatMap((group) => group.books) }];
}

export function CoverGrid({ books, onOpen, profile = null }: { books: Book[]; onOpen: (book: Book) => void; profile?: Profile | null }) {
  const groups = shelfGroups(books);
  return (
    <div className="space-y-4">
      {groups.map((group, index) => (
        <section key={group.section ?? `rest-${index}`} aria-label={group.section !== null ? `Shelf ${group.section}` : groups.length > 1 ? "Not placed" : undefined}>
          {groups.length > 1 && (
            <h2 className="mono mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-[#6a584d]">{group.section !== null ? `Shelf ${group.section}` : "Not placed"}</h2>
          )}
          <ul className="grid grid-cols-3 gap-2">
            {group.books.map((book) => {
              const title = bookTitle(book);
              const author = book.authors[0] ?? "Author unknown";
              const forYou = bookMatchesProfile(book, profile);
              return (
                <li key={book.key}>
                  <button className={`w-full rounded-lg text-left ${forYou ? "ring-2 ring-[#7c3aed]" : ""}`} type="button" onClick={() => onOpen(book)} aria-label={`Cover of ${title}`}>
                    <CoverFace book={book} className="aspect-[2/3] w-full rounded-lg object-cover" />
                    {forYou && <p className="mt-2 text-xs font-semibold uppercase tracking-wide text-[#7c3aed]">For you</p>}
                    <h2 className="mt-2 text-sm leading-5">{title}</h2>
                    <p className="text-xs text-[#6a584d]">{author}</p>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
