import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { Book } from "../../shared/types.ts";
import { GENRE_LABELS } from "../../shared/types.ts";
import { askShelf } from "./api";
import { nearest } from "./pipeline/graph";
import { genreSections, topRated, withScores } from "./pipeline/score";
import { enrichOne, scanPhotos } from "./scan";
import { currentSession, useShelf } from "./store";
import { MapView } from "./MapView";

const TABS = [
  ["shelf", "Shelf"],
  ["rated", "Top Rated"],
  ["genres", "Genres"],
  ["map", "Map"],
] as const;

function accessCode() {
  return sessionStorage.getItem("shelf-access-code") ?? "";
}

export function App() {
  const shelf = useShelf();
  const session = currentSession(shelf);
  const books = useMemo(() => withScores(session?.books ?? []), [session?.books]);
  const [code, setCode] = useState(accessCode);
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState<Book | null>(null);
  const [question, setQuestion] = useState("");
  const [rawOrder, setRawOrder] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    void shelf.hydrate();
  }, [shelf.hydrate]);

  function saveCode(value: string) {
    setCode(value);
    sessionStorage.setItem("shelf-access-code", value);
  }

  async function onFiles(list: FileList | File[]) {
    const files = [...list].filter((file) => file.type.startsWith("image/") || /\.(jpe?g|png|heic|webp)$/i.test(file.name));
    if (!files.length) return;
    if (!code.trim()) {
      setNotice("Enter the access code first.");
      return;
    }
    setNotice("");
    try {
      await scanPhotos(files, code.trim());
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "The scan failed.");
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || !books.length) return;
    shelf.setAsking(true);
    shelf.setAnswer("");
    try {
      await askShelf(question.trim(), books, code.trim(), (chunk) => {
        shelf.setAnswer(useShelf.getState().answer + chunk);
      });
    } catch (err) {
      shelf.setAnswer(err instanceof Error ? err.message : "Ask failed.");
    } finally {
      shelf.setAsking(false);
    }
  }

  const rated = topRated(rawOrder ? books.map((book) => ({ ...book, score: book.avgRating })) : books);
  const sections = genreSections(books);
  const strong = sections.filter((section) => section.ratedCount >= 2);
  const also = sections.filter((section) => section.ratedCount < 2);

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-24 pt-5">
      <header className="mb-4 flex items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[#6d6458]">Library shelf</p>
          <h1 className="serif text-3xl leading-none">Shelf Scanner</h1>
        </div>
        <button className="rounded-full border border-[#1c1915] px-3 py-1 text-sm" type="button" onClick={() => setDrawer(true)}>
          Sessions
        </button>
      </header>

      <label className="mb-3 block text-sm">
        Access code
        <input
          aria-label="Access code"
          className="mt-1 w-full rounded-xl border border-[#d9d0c2] bg-white px-3 py-2"
          value={code}
          onChange={(event) => saveCode(event.target.value)}
          autoComplete="off"
        />
      </label>

      {!session && (
        <Capture notice={notice} onFiles={onFiles} />
      )}

      {session && (
        <>
          <form className="mb-3 flex gap-2" onSubmit={ask}>
            <input
              aria-label="Ask the shelf"
              className="min-w-0 flex-1 rounded-xl border border-[#d9d0c2] bg-white px-3 py-2"
              placeholder="Ask the shelf"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button className="rounded-xl bg-[#1f4d3a] px-3 py-2 text-white" type="submit" disabled={shelf.asking}>
              {shelf.asking ? "…" : "Ask"}
            </button>
          </form>
          {shelf.answer && <p className="mb-3 rounded-xl bg-white p-3 text-sm leading-6">{shelf.answer}</p>}
          {shelf.progress && <p className="mb-3 text-sm text-[#6d6458]">{shelf.progress}</p>}
          <div className="mb-3">
            <Capture notice={notice} compact onFiles={onFiles} />
          </div>

          {shelf.tab === "shelf" && (
            <ul className="space-y-3">
              {books.map((book) => (
                <BookCard key={book.key} book={book} onEdit={() => setEditing(book)} onRetry={() => void enrichOne(book.key, book.detections[0]?.title ?? book.key, book.detections[0]?.author ?? null, code.trim())} />
              ))}
            </ul>
          )}

          {shelf.tab === "rated" && (
            <section>
              <label className="mb-3 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={rawOrder} onChange={(event) => setRawOrder(event.target.checked)} />
                Raw average instead of weighted rating
              </label>
              <RatedGroup title="Goodreads" books={rated.goodreads} />
              <RatedGroup title="Rated elsewhere" books={rated.elsewhere} />
              <RatedGroup title="No rating found" books={rated.unrated} />
            </section>
          )}

          {shelf.tab === "genres" && (
            <section className="space-y-4">
              <h2 className="serif text-xl">Strongest genres on this shelf</h2>
              {strong.map((section) => (
                <GenreBlock key={section.genre} genre={GENRE_LABELS[section.genre]} books={section.books} best={section.best} />
              ))}
              {also.length > 0 && (
                <div>
                  <h3 className="mb-2 text-sm uppercase tracking-wide text-[#6d6458]">Also on this shelf</h3>
                  <ul className="space-y-1 text-sm">
                    {also.flatMap((section) => section.books).map((book) => (
                      <li key={book.key}>{book.canonicalTitle ?? book.key}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {shelf.tab === "map" && <MapView books={books} />}
        </>
      )}

      <nav className="fixed inset-x-0 bottom-0 border-t border-[#e4d9c8] bg-[#f3ecdf]/95 px-3 py-2 backdrop-blur">
        <div className="mx-auto grid max-w-3xl grid-cols-4 gap-1" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={shelf.tab === id}
              className={`rounded-full px-2 py-2 text-sm ${shelf.tab === id ? "bg-[#1c1915] text-[#f3ecdf]" : ""}`}
              type="button"
              onClick={() => shelf.setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {drawer && (
        <aside className="fixed inset-0 z-20 bg-black/30" onClick={() => setDrawer(false)}>
          <div className="ml-auto h-full w-80 bg-[#f7f1e7] p-4" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="serif text-2xl">Sessions</h2>
              <button type="button" onClick={() => setDrawer(false)}>Close</button>
            </div>
            <ul className="space-y-2">
              {shelf.sessions.map((item) => (
                <li key={item.id}>
                  <button className="w-full rounded-xl bg-white px-3 py-2 text-left" type="button" onClick={() => { shelf.openSession(item.id); setDrawer(false); }}>
                    {new Date(item.createdAt).toLocaleString()} · {item.books.length} books
                  </button>
                </li>
              ))}
            </ul>
            <button className="mt-4 text-sm underline" type="button" onClick={() => { shelf.clearLocal(); setDrawer(false); }}>
              Clear
            </button>
          </div>
        </aside>
      )}

      {editing && (
        <EditDialog
          book={editing}
          onClose={() => setEditing(null)}
          onSave={async (title, author) => {
            await enrichOne(editing.key, title, author, code.trim());
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Capture({ onFiles, notice, compact = false }: { onFiles: (files: FileList | File[]) => void; notice: string; compact?: boolean }) {
  return (
    <label
      className={`block rounded-2xl border border-dashed border-[#b7ab99] bg-white/70 p-4 ${compact ? "" : "py-10 text-center"}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onFiles(event.dataTransfer.files);
      }}
    >
      <span className="serif block text-lg">{compact ? "Add another photo" : "Photograph a shelf"}</span>
      <span className="mt-1 block text-sm text-[#6d6458]">Straight on, one or two rows, no glare.</span>
      <input
        aria-label="Shelf photo"
        className="mt-3 block w-full text-sm"
        type="file"
        accept="image/*"
        capture="environment"
        multiple
        onChange={(event) => event.target.files && onFiles(event.target.files)}
      />
      {notice && <p className="mt-2 text-sm text-[#8a3b2c]">{notice}</p>}
    </label>
  );
}

function BookCard({ book, onEdit, onRetry }: { book: Book; onEdit: () => void; onRetry: () => void }) {
  const title = book.canonicalTitle ?? book.detections[0]?.title ?? "Unread spine";
  const spine = book.detections[0]?.spineText;
  return (
    <li className="rounded-2xl bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="serif text-xl leading-tight">{book.status === "queued" || book.status === "enriching" ? "…" : title}</h2>
          <p className="text-sm text-[#6d6458]">{book.authors.join(", ") || (book.status === "enriching" ? "Looking it up" : "Author unknown")}</p>
        </div>
        {book.avgRating != null && <span className="text-sm">{book.avgRating.toFixed(2)}</span>}
      </div>
      {book.summary && <p className="mt-2 text-sm leading-6">{book.summary}</p>}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {book.status === "unmatched" && <span>Couldn&apos;t verify</span>}
        {book.status === "error" && <button type="button" onClick={onRetry}>Retry</button>}
        {book.flags.includes("unverified_rating") && <span className="rounded-full bg-[#ece7df] px-2 py-1">Unverified rating</span>}
        {book.flags.includes("possible_mismatch") && (
          <button className="rounded-full bg-[#f3d7a1] px-2 py-1" type="button" onClick={onEdit}>
            Spine: {spine}
          </button>
        )}
        {(book.status === "unmatched" || book.flags.includes("possible_mismatch")) && (
          <button className="underline" type="button" onClick={onEdit}>Edit</button>
        )}
      </div>
    </li>
  );
}

function RatedGroup({ title, books }: { title: string; books: Book[] }) {
  if (!books.length) return null;
  return (
    <section className="mb-4">
      <h2 className="mb-2 text-sm uppercase tracking-wide text-[#6d6458]">{title}</h2>
      <ol className="space-y-2">
        {books.map((book, index) => (
          <li key={book.key} className="flex items-baseline justify-between gap-3 rounded-xl bg-white px-3 py-2">
            <span><span className="mr-2 text-[#6d6458]">{index + 1}</span>{book.canonicalTitle ?? book.key}</span>
            <span className="text-sm text-[#6d6458]">{book.avgRating?.toFixed(2) ?? "—"} · {book.ratingsCount ?? 0}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function GenreBlock({ genre, books, best }: { genre: string; books: Book[]; best: Book | null }) {
  return (
    <article className="rounded-2xl bg-white p-4">
      <h3 className="serif text-lg">{genre}</h3>
      {best && <p className="mt-1">Best: {best.canonicalTitle ?? best.key}</p>}
      <ul className="mt-2 space-y-1 text-sm text-[#6d6458]">
        {books.filter((book) => book.key !== best?.key).map((book) => (
          <li key={book.key}>{book.canonicalTitle ?? book.key}</li>
        ))}
      </ul>
    </article>
  );
}

function EditDialog({ book, onClose, onSave }: { book: Book; onClose: () => void; onSave: (title: string, author: string | null) => Promise<void> }) {
  const [title, setTitle] = useState(book.canonicalTitle ?? book.detections[0]?.title ?? "");
  const [author, setAuthor] = useState(book.authors[0] ?? book.detections[0]?.author ?? "");
  return (
    <div className="fixed inset-0 z-30 grid place-items-end bg-black/30 p-4 sm:place-items-center" role="dialog" aria-modal="true">
      <form
        className="w-full max-w-md rounded-2xl bg-[#f7f1e7] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(title, author || null);
        }}
      >
        <h2 className="serif text-2xl">Edit this reading</h2>
        <p className="mt-2 text-sm text-[#6d6458]">{book.detections[0]?.spineText || "No spine text was captured."}</p>
        <label className="mt-3 block text-sm">
          Title
          <input className="mt-1 w-full rounded-xl border bg-white px-3 py-2" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="mt-3 block text-sm">
          Author
          <input className="mt-1 w-full rounded-xl border bg-white px-3 py-2" value={author} onChange={(event) => setAuthor(event.target.value)} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="rounded-full bg-[#1c1915] px-3 py-1 text-[#f3ecdf]" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
