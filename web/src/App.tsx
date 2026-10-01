import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { Book } from "../../shared/types.ts";
import { GENRE_LABELS } from "../../shared/types.ts";
import { askShelf } from "./api";
import { nearest } from "./pipeline/graph";
import { genreSections, topRated, withScores } from "./pipeline/score";
import { enrichOne, scanPhotos } from "./scan";
import { currentSession, useShelf } from "./store";
import { CameraScan } from "./CameraScan";
import { MapView } from "./MapView";
import { SPLASH_MS, Splash } from "./Splash";
import { StillCallouts } from "./StillCallouts";

const TABS = [
  ["shelf", "Shelf"],
  ["rated", "Top Rated"],
  ["genres", "Genres"],
  ["map", "Map"],
] as const;

export function App() {
  const shelf = useShelf();
  const session = currentSession(shelf);
  const books = useMemo(() => withScores(session?.books ?? []), [session?.books]);
  const [drawer, setDrawer] = useState(false);
  const [editing, setEditing] = useState<Book | null>(null);
  const [question, setQuestion] = useState("");
  const [rawOrder, setRawOrder] = useState(false);
  const [notice, setNotice] = useState("");
  const [live, setLive] = useState(true);
  const [splash, setSplash] = useState(true);
  const [stillPhoto, setStillPhoto] = useState<{ url: string; captureId: string } | null>(null);
  const latestUpload = useRef<string | null>(null);

  useEffect(() => {
    void shelf.hydrate();
  }, [shelf.hydrate]);

  useEffect(() => {
    const timer = setTimeout(() => setSplash(false), SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    if (stillPhoto) URL.revokeObjectURL(stillPhoto.url);
  }, [stillPhoto]);

  async function onFiles(list: FileList | File[]) {
    const files = [...list].filter((file) => file.type.startsWith("image/") || /\.(jpe?g|png|heic|webp)$/i.test(file.name));
    if (!files.length) return;
    const captureId = crypto.randomUUID();
    latestUpload.current = captureId;
    setStillPhoto((current) => {
      if (current) URL.revokeObjectURL(current.url);
      return files.length === 1 ? { url: URL.createObjectURL(files[0]), captureId } : null;
    });
    setLive(false);
    setNotice("");
    try {
      await scanPhotos(files, { captureId });
    } catch (err) {
      setStillPhoto((current) => {
        if (current?.captureId === captureId) URL.revokeObjectURL(current.url);
        return current?.captureId === captureId ? null : current;
      });
      if (latestUpload.current === captureId) setNotice(err instanceof Error ? err.message : "The scan failed.");
    }
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!question.trim() || !books.length) return;
    shelf.setAsking(true);
    shelf.setAnswer("");
    try {
      await askShelf(question.trim(), books, (chunk) => {
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
          <p className="mono text-xs uppercase tracking-[0.14em] text-[#6a584d]">Library shelf</p>
          <h1 className="display whitespace-nowrap text-[30px] leading-none">Shelf Scanner</h1>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          {/* Over the camera the toggle floats top right; on the page it sits above Sessions instead of covering it. */}
          <button
            className={`whitespace-nowrap rounded-full bg-[#1f1a17] px-3 py-1 text-sm text-[#fffaf6] ${live ? "fixed right-4 top-4 z-50" : ""}`}
            type="button"
            aria-pressed={live}
            onClick={() => setLive((on) => !on)}
          >
            {live ? "Live view on" : "Live view"}
          </button>
          <button className="whitespace-nowrap rounded-full border border-[#1f1a17] px-3 py-1 text-sm" type="button" onClick={() => setDrawer(true)}>
            Sessions
          </button>
        </div>
      </header>

      {!session && (
        <Capture notice={notice} onFiles={onFiles} />
      )}

      {session && (
        <>
          <form className="mb-3 flex gap-2" onSubmit={ask}>
            <input
              aria-label="Ask the shelf"
              className="row min-w-0 flex-1 px-3 py-2"
              placeholder="Ask the shelf"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
            />
            <button className="rounded-xl bg-[#ff6b35] px-3 py-2 font-semibold text-[#1f1a17]" type="submit" disabled={shelf.asking}>
              {shelf.asking ? "…" : "Ask"}
            </button>
          </form>
          {shelf.answer && <p className="row mb-3 p-3 text-sm leading-6">{shelf.answer}</p>}
          {shelf.progress && <p className="mb-3 text-sm text-[#6a584d]">{shelf.progress}</p>}
          <div className="mb-3">
            <Capture notice={notice} compact onFiles={onFiles} />
          </div>

          {shelf.tab === "shelf" && stillPhoto?.captureId === session.id && <StillCallouts url={stillPhoto.url} books={books} captureId={session.id} />}

          {shelf.tab === "shelf" && (
            <ul className="space-y-3">
              {books.map((book) => (
                <BookCard key={book.key} book={book} onEdit={() => setEditing(book)} onRetry={() => void enrichOne(book.key, book.detections[0]?.title ?? book.key, book.detections[0]?.author ?? null)} />
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
              <h2 className="display text-xl">Strongest genres on this shelf</h2>
              {strong.map((section) => (
                <GenreBlock key={section.genre} genre={GENRE_LABELS[section.genre]} books={section.books} best={section.best} />
              ))}
              {also.length > 0 && (
                <div>
                  <h3 className="mono mb-2 text-xs uppercase tracking-[0.06em] text-[#6a584d]">Also on this shelf</h3>
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

      <nav className="fixed inset-x-0 bottom-0 border-t border-[#ede6df] bg-[#fffaf6]/90 px-3 py-2 backdrop-blur-md">
        <div className="mx-auto grid max-w-3xl grid-cols-4 gap-1" role="tablist">
          {TABS.map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={shelf.tab === id}
              className={`whitespace-nowrap rounded-full p-2 text-sm ${shelf.tab === id ? "bg-[#1f1a17] text-[#fffaf6]" : "text-[#1f1a17]"}`}
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
          <div className="ml-auto h-full w-80 bg-[#f8f4ef] p-4" onClick={(event) => event.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="display text-2xl">Sessions</h2>
              <button type="button" onClick={() => setDrawer(false)}>Close</button>
            </div>
            <ul className="space-y-2">
              {shelf.sessions.map((item) => (
                <li key={item.id}>
                  <button className="row w-full px-3 py-2 text-left" type="button" onClick={() => { shelf.openSession(item.id); setDrawer(false); }}>
                    {new Date(item.createdAt).toLocaleString()} · {item.books.length} books
                  </button>
                </li>
              ))}
            </ul>
            <button className="mt-4 text-sm underline" type="button" onClick={() => { shelf.clearLocal(); setStillPhoto(null); setDrawer(false); }}>
              Clear
            </button>
          </div>
        </aside>
      )}

      {live && <CameraScan onClose={() => setLive(false)} />}

      {splash && <Splash />}

      {editing && (
        <EditDialog
          book={editing}
          onClose={() => setEditing(null)}
          onSave={async (title, author) => {
            await enrichOne(editing.key, title, author);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function Capture({ onFiles, notice, compact = false }: { onFiles: (files: FileList | File[]) => void; notice: string; compact?: boolean }) {
  return (
    <div
      className={`rounded-[18px] border border-dashed border-[#cdbfb2] bg-white/70 p-4 ${compact ? "" : "py-10 text-center"}`}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        onFiles(event.dataTransfer.files);
      }}
    >
      <span className="display block text-lg font-normal">{compact ? "Add another photo" : "Photograph a shelf"}</span>
      <span className="mt-1 block text-sm text-[#6a584d]">Straight on, one or two rows, no glare.</span>
      <label className="mt-3 block text-sm">
        Shelf photo
        <input
          aria-label="Shelf photo"
          className="mt-1 block w-full"
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={(event) => event.target.files && onFiles(event.target.files)}
        />
      </label>
      {notice && <p className="mt-2 text-sm text-[#dc2626]">{notice}</p>}
    </div>
  );
}

function BookCard({ book, onEdit, onRetry }: { book: Book; onEdit: () => void; onRetry: () => void }) {
  const title = book.canonicalTitle ?? book.detections[0]?.title ?? "Unread spine";
  const spine = book.detections[0]?.spineText;
  return (
    <li className="card p-4 shadow-[0_8px_24px_rgba(22,15,11,0.06)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="display text-xl leading-tight">{book.mark ? `${book.mark} ` : ""}{title}</h2>
          <p className="text-sm text-[#6a584d]">{book.authors.join(", ") || (book.status === "enriching" ? "Looking it up" : "Author unknown")}</p>
        </div>
        {book.avgRating != null && <span className="text-sm">{book.avgRating.toFixed(2)}</span>}
      </div>
      {book.summary && <p className="mt-2 text-sm leading-6">{book.summary}</p>}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        {book.status === "unmatched" && <span>Couldn&apos;t verify</span>}
        {book.status === "error" && <button type="button" onClick={onRetry}>Retry</button>}
        {book.flags.includes("unverified_rating") && <span className="rounded-full bg-[#f1ebe4] px-2 py-1">Unverified rating</span>}
        {book.flags.includes("possible_mismatch") && (
          <button className="rounded-full bg-[#ffe1d4] px-2 py-1" type="button" onClick={onEdit}>
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
      <h2 className="mono mb-2 text-xs font-semibold uppercase tracking-[0.06em] text-[#6a584d]">{title}</h2>
      <ol className="space-y-2">
        {books.map((book, index) => (
          <li key={book.key} className="row flex items-baseline justify-between gap-3 px-3 py-2">
            <span><span className="mr-2 text-[#6a584d]">{index + 1}</span>{book.canonicalTitle ?? book.key}</span>
            <span className="whitespace-nowrap text-sm text-[#6a584d]">{book.avgRating?.toFixed(2) ?? "—"} · {book.ratingsCount ?? 0}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function GenreBlock({ genre, books, best }: { genre: string; books: Book[]; best: Book | null }) {
  return (
    <article className="card p-4">
      <h3 className="display text-lg">{genre}</h3>
      {best && <p className="mt-1">Best: {best.canonicalTitle ?? best.key}</p>}
      <ul className="mt-2 space-y-1 text-sm text-[#6a584d]">
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
        className="w-full max-w-md rounded-[18px] bg-[#f8f4ef] p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void onSave(title, author || null);
        }}
      >
        <h2 className="display text-2xl">Edit this reading</h2>
        <p className="mt-2 text-sm text-[#6a584d]">{book.detections[0]?.spineText || "No spine text was captured."}</p>
        <label className="mt-3 block text-sm">
          Title
          <input className="row mt-1 w-full px-3 py-2" value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="mt-3 block text-sm">
          Author
          <input className="row mt-1 w-full px-3 py-2" value={author} onChange={(event) => setAuthor(event.target.value)} />
        </label>
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="rounded-full bg-[#1f1a17] px-3 py-1 text-[#fffaf6]" type="submit">Save</button>
        </div>
      </form>
    </div>
  );
}
