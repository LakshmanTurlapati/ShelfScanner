import { get, set } from "idb-keyval";
import { create } from "zustand";
import type { Book, Session } from "../../shared/types.ts";
import { pinFor, shelfOrigin } from "./walk.ts";

const STORE_KEY = "shelf-scanner-sessions";

type State = {
  ready: boolean;
  sessions: Session[];
  currentId: string | null;
  progress: string;
  tab: "shelf" | "rated" | "genres" | "map";
  answer: string;
  asking: boolean;
  hydrate: () => Promise<void>;
  setTab: (tab: State["tab"]) => void;
  setAnswer: (answer: string) => void;
  setAsking: (asking: boolean) => void;
  beginSession: (photoCount: number, id?: string, mode?: "still" | "walk") => string;
  setBooksFor: (id: string, books: Book[]) => void;
  mergeBooksFor: (id: string, books: Book[]) => void;
  addFrame: (id: string) => void;
  patchBookFor: (id: string, key: string, patch: Partial<Book>) => void;
  setProgressFor: (id: string, progress: string) => void;
  removeSession: (id: string) => void;
  openSession: (id: string) => void;
  clearLocal: () => void;
};

const PERSIST_MS = 500;
let unsaved: { sessions: Session[]; currentId: string | null } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (!unsaved) return;
  const snapshot = unsaved;
  unsaved = null;
  // IndexedDB runs readwrite transactions in the order they are created, so writes need no chaining.
  void set(STORE_KEY, snapshot).catch(() => undefined);
}

// A scan patches books many times a second; one write per 500ms keeps IndexedDB off the hot path.
function persist(sessions: Session[], currentId: string | null) {
  unsaved = { sessions, currentId };
  timer ??= setTimeout(flush, PERSIST_MS);
}

if (typeof document !== "undefined") {
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}

// A book's key comes from its reading, so a sharper twin from another strip can rename it.
// A renamed book is found by the spines it shares with a book that is no longer read.
export function renamedKeys(current: Book[], books: Book[]) {
  const keys = new Set(books.map((book) => book.key));
  const known = new Set(current.map((book) => book.key));
  const owner = new Map(current.filter((book) => !keys.has(book.key)).flatMap((book) =>
    book.detections.flatMap((detection) => (detection.id ? [[detection.id, book.key] as const] : []))));
  const renamed = new Map<string, string>();
  for (const book of books) {
    if (known.has(book.key)) continue;
    const from = book.detections.map((detection) => detection.id && owner.get(detection.id)).find(Boolean);
    if (from && !renamed.has(from)) renamed.set(from, book.key);
  }
  return renamed;
}

const CONTRACT = 1;

function withoutKey(book: Book, key: "pin" | "coverId"): Book {
  const next = { ...book };
  delete next[key];
  return next;
}

function finitePin(value: unknown): value is { x: number; row: number } {
  if (!value || typeof value !== "object") return false;
  const pin = value as { x?: unknown; row?: unknown };
  return typeof pin.x === "number" && Number.isFinite(pin.x) && typeof pin.row === "number" && Number.isFinite(pin.row);
}

function legalCover(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value) && value > 0);
}

// A missing cover id must stay missing. Assigning undefined creates a key IndexedDB will keep.
function coverChoice(stored: Book, incoming: Book): number | null | undefined {
  if (stored.coverId !== undefined) return legalCover(stored.coverId) ? stored.coverId : undefined;
  if (incoming.coverId !== undefined) return legalCover(incoming.coverId) ? incoming.coverId : undefined;
  return undefined;
}

function pinChoice(stored: Book, incoming: Book): Book["pin"] | undefined {
  if (finitePin(stored.pin)) return { x: stored.pin.x, row: stored.pin.row };
  if (finitePin(incoming.pin)) return { x: incoming.pin.x, row: incoming.pin.row };
  return undefined;
}

function applyPlace(book: Book, pin: Book["pin"] | undefined, coverId: number | null | undefined): Book {
  let next = book;
  if (pin === undefined) {
    if ("pin" in next) next = withoutKey(next, "pin");
  } else next = { ...next, pin };
  if (coverId === undefined) {
    if ("coverId" in next) next = withoutKey(next, "coverId");
  } else next = { ...next, coverId };
  return next;
}

// Fields a lookup has patched survive a re-read, and follow a renamed book; only what comes from the photo is replaced.
function mergeBooks(current: Book[], books: Book[], keepAbsent = false) {
  const renamed = renamedKeys(current, books);
  const before = new Map(current.map((book) => [book.key, book]));
  for (const [from, to] of renamed) before.set(to, before.get(from)!);
  const merged = books.map((book) => {
    const old = before.get(book.key);
    if (!old) return book;
    const next = { ...old, key: book.key, detections: book.detections, mark: book.mark, box: book.box };
    return applyPlace(next, pinChoice(old, book), coverChoice(old, book));
  });
  if (!keepAbsent) return merged;
  const incoming = new Set<string>([...merged.map((book) => book.key), ...renamed.keys()]);
  return [...current.filter((book) => !incoming.has(book.key)), ...merged];
}

function withoutDisallowed(session: Session, book: Book): Book {
  const stamped = session.contract === CONTRACT;
  const walk = stamped && session.mode === "walk";
  let next = book;
  const pinMissing = !("pin" in next) || next.pin === undefined || (!finitePin(next.pin) && next.pin !== null);
  if (!walk || pinMissing) {
    if (walk && pinMissing) {
      const placed = pinFor(next, shelfOrigin(session.id));
      if (placed) next = { ...next, pin: placed };
      else if ("pin" in next) next = withoutKey(next, "pin");
    } else if ("pin" in next) next = withoutKey(next, "pin");
  } else if (finitePin(next.pin)) {
    next = { ...next, pin: { x: next.pin.x, row: next.pin.row } };
  }
  if (!stamped || !("coverId" in next) || next.coverId === undefined || !legalCover(next.coverId)) {
    if ("coverId" in next) next = withoutKey(next, "coverId");
  }
  return next;
}

export const useShelf = create<State>((setState, getState) => ({
  ready: false,
  sessions: [],
  currentId: null,
  progress: "",
  tab: "shelf",
  answer: "",
  asking: false,
  hydrate: async () => {
    const saved = (await get(STORE_KEY)) as { sessions: Session[]; currentId: string | null } | undefined;
    if (getState().currentId) {
      setState({ ready: true });
      return;
    }
    setState({ ready: true, sessions: saved?.sessions ?? [], currentId: saved?.currentId ?? null });
  },
  setTab: (tab) => setState({ tab }),
  setAnswer: (answer) => setState({ answer }),
  setAsking: (asking) => setState({ asking }),
  beginSession: (photoCount, id = crypto.randomUUID(), mode: "still" | "walk" = "still") => {
    const session: Session = { id, createdAt: new Date().toISOString(), photoCount, books: [], contract: CONTRACT, mode };
    const sessions = [session, ...getState().sessions];
    setState({ sessions, currentId: id, tab: "shelf", answer: "", progress: "" });
    persist(sessions, id);
    return id;
  },
  setBooksFor: (id, books) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) => (session.id === id ? { ...session, books: books.map((book) => withoutDisallowed(session, book)) } : session));
    setState({ sessions: next });
    persist(next, currentId);
  },
  mergeBooksFor: (id, books) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) =>
      session.id === id
        ? {
            ...session,
            books: mergeBooks(session.books, books, session.contract === CONTRACT && session.mode === "walk").map((book) => withoutDisallowed(session, book)),
          }
        : session,
    );
    setState({ sessions: next });
    persist(next, currentId);
  },
  addFrame: (id) => {
    const { sessions } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) => (session.id === id ? { ...session, photoCount: session.photoCount + 1 } : session));
    setState({ sessions: next, currentId: id });
    persist(next, id);
  },
  patchBookFor: (id, key, patch) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) =>
      session.id === id
        ? { ...session, books: session.books.map((book) => (book.key === key ? withoutDisallowed(session, { ...book, ...patch }) : book)) }
        : session,
    );
    setState({ sessions: next });
    persist(next, currentId);
  },
  setProgressFor: (id, progress) => {
    if (getState().currentId === id) setState({ progress });
  },
  removeSession: (id) => {
    const { sessions, currentId, progress } = getState();
    const next = sessions.filter((session) => session.id !== id);
    const selected = currentId === id ? next[0]?.id ?? null : currentId;
    setState({ sessions: next, currentId: selected, progress: currentId === id ? "" : progress });
    persist(next, selected);
  },
  openSession: (id) => {
    setState({ currentId: id, tab: "shelf", progress: "" });
    persist(getState().sessions, id);
  },
  clearLocal: () => {
    setState({ sessions: [], currentId: null, progress: "", answer: "" });
    persist([], null);
  },
}));

export function currentSession(state: State) {
  return state.sessions.find((session) => session.id === state.currentId) ?? null;
}
