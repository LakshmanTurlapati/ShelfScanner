import { get, set } from "idb-keyval";
import { create } from "zustand";
import type { Book, Session } from "../../shared/types.ts";

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
  beginSession: (photoCount: number, id?: string) => string;
  setBooksFor: (id: string, books: Book[]) => void;
  mergeBooksFor: (id: string, books: Book[]) => void;
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

// Fields a lookup has patched survive a re-read, and follow a renamed book; only what comes from the photo is replaced.
function mergeBooks(current: Book[], books: Book[]) {
  const before = new Map(current.map((book) => [book.key, book]));
  for (const [from, to] of renamedKeys(current, books)) before.set(to, before.get(from)!);
  return books.map((book) => {
    const old = before.get(book.key);
    return old ? { ...old, key: book.key, detections: book.detections, mark: book.mark, box: book.box } : book;
  });
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
  beginSession: (photoCount, id = crypto.randomUUID()) => {
    const session: Session = { id, createdAt: new Date().toISOString(), photoCount, books: [] };
    const sessions = [session, ...getState().sessions];
    setState({ sessions, currentId: id, tab: "shelf", answer: "", progress: "" });
    persist(sessions, id);
    return id;
  },
  setBooksFor: (id, books) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) => (session.id === id ? { ...session, books } : session));
    setState({ sessions: next });
    persist(next, currentId);
  },
  mergeBooksFor: (id, books) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) => (session.id === id ? { ...session, books: mergeBooks(session.books, books) } : session));
    setState({ sessions: next });
    persist(next, currentId);
  },
  patchBookFor: (id, key, patch) => {
    const { sessions, currentId } = getState();
    if (!sessions.some((session) => session.id === id)) return;
    const next = sessions.map((session) =>
      session.id === id
        ? { ...session, books: session.books.map((book) => (book.key === key ? { ...book, ...patch } : book)) }
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
