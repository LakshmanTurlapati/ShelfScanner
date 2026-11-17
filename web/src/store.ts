import { get, set } from "idb-keyval";
import { create } from "zustand";
import type { Book, Session } from "../../shared/types.ts";
import { clonePin, finitePin } from "./pin.ts";
import { currentWalk, endWalk, onFramesMoved, pinFor } from "./walk.ts";

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
  repinFrames: (frameIds: readonly string[]) => void;
  setProgressFor: (id: string, progress: string) => void;
  removeSession: (id: string) => void;
  openSession: (id: string) => void;
  clearLocal: () => void;
};

const PERSIST_MS = 500;
// A long library walk holds hundreds of books, each with an embedding, so the whole history is
// written less often once it is that large. Hiding the page still writes it straight away.
const PERSIST_LARGE_MS = 2000;
const LARGE_HISTORY = 300;
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
  const books = sessions.reduce((sum, session) => sum + session.books.length, 0);
  timer ??= setTimeout(flush, books > LARGE_HISTORY ? PERSIST_LARGE_MS : PERSIST_MS);
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

// Each enriched book carries a 1,536-number embedding, and the whole history is rewritten during a
// scan, so the phone keeps the newest shelves only. The open shelf is never dropped.
export const MAX_SESSIONS = 20;

export function capSessions(sessions: Session[], keep: string | null) {
  if (sessions.length <= MAX_SESSIONS) return sessions;
  const newest = [...sessions].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const kept = new Set(newest.slice(0, MAX_SESSIONS).map((session) => session.id));
  if (keep && !kept.has(keep) && sessions.some((session) => session.id === keep)) {
    kept.delete(newest[MAX_SESSIONS - 1].id);
    kept.add(keep);
  }
  return sessions.filter((session) => kept.has(session.id));
}

function withoutKey(book: Book, key: "pin" | "coverId" | "coverUrl"): Book {
  const next = { ...book };
  delete next[key];
  return next;
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

function legalCoverUrl(value: unknown): value is string | null {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (url.protocol === "http:") url.protocol = "https:";
    return url.protocol === "https:";
  } catch {
    return false;
  }
}

function storedCoverUrl(value: string | null): string | null {
  if (value === null) return null;
  const url = new URL(value);
  if (url.protocol === "http:") url.protocol = "https:";
  return url.toString();
}

function coverUrlChoice(stored: Book, incoming: Book): string | null | undefined {
  if (stored.coverUrl !== undefined) return legalCoverUrl(stored.coverUrl) ? storedCoverUrl(stored.coverUrl) : undefined;
  if (incoming.coverUrl !== undefined) return legalCoverUrl(incoming.coverUrl) ? storedCoverUrl(incoming.coverUrl) : undefined;
  return undefined;
}

function pinChoice(stored: Book, incoming: Book): Book["pin"] | undefined {
  if (finitePin(stored.pin)) return clonePin(stored.pin);
  if (finitePin(incoming.pin)) return clonePin(incoming.pin);
  return undefined;
}

function applyPlace(book: Book, pin: Book["pin"] | undefined, coverId: number | null | undefined, coverUrl: string | null | undefined): Book {
  let next = book;
  if (pin === undefined) {
    if ("pin" in next) next = withoutKey(next, "pin");
  } else next = { ...next, pin };
  if (coverId === undefined) {
    if ("coverId" in next) next = withoutKey(next, "coverId");
  } else next = { ...next, coverId };
  if (coverUrl === undefined) {
    if ("coverUrl" in next) next = withoutKey(next, "coverUrl");
  } else next = { ...next, coverUrl };
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
    return applyPlace(next, pinChoice(old, book), coverChoice(old, book), coverUrlChoice(old, book));
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
      const placed = pinFor(next);
      if (placed) next = { ...next, pin: placed };
      else if ("pin" in next) next = withoutKey(next, "pin");
    } else if ("pin" in next) next = withoutKey(next, "pin");
  } else if (finitePin(next.pin)) {
    next = { ...next, pin: clonePin(next.pin) };
  }
  if (!stamped || !("coverId" in next) || next.coverId === undefined || !legalCover(next.coverId)) {
    if ("coverId" in next) next = withoutKey(next, "coverId");
  }
  if (!stamped || !("coverUrl" in next) || next.coverUrl === undefined || !legalCoverUrl(next.coverUrl)) {
    if ("coverUrl" in next) next = withoutKey(next, "coverUrl");
  } else if (next.coverUrl) {
    next = { ...next, coverUrl: storedCoverUrl(next.coverUrl) };
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
    let saved: { sessions: Session[]; currentId: string | null } | undefined;
    try {
      saved = (await get(STORE_KEY)) as typeof saved;
    } catch {
      saved = undefined;
    }
    // A read can start before the saved shelves load (the splash lets taps through). Merging keeps
    // both, where replacing would drop the history and the next write would make that permanent.
    const { sessions: live, currentId } = getState();
    const known = new Set(live.map((session) => session.id));
    // The cap must keep the shelf that will be open, which may be the saved one.
    const selected = currentId ?? saved?.currentId ?? null;
    const sessions = capSessions([...live, ...(saved?.sessions ?? []).filter((session) => !known.has(session.id))], selected);
    setState({ ready: true, sessions, currentId: selected });
    if (live.length) persist(sessions, selected);
  },
  setTab: (tab) => setState({ tab }),
  setAnswer: (answer) => setState({ answer }),
  setAsking: (asking) => setState({ asking }),
  beginSession: (photoCount, id = crypto.randomUUID(), mode: "still" | "walk" = "still") => {
    const session: Session = { id, createdAt: new Date().toISOString(), photoCount, books: [], contract: CONTRACT, mode };
    const sessions = capSessions([session, ...getState().sessions], id);
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
  // A read placed better (matched titles, or linked to an earlier read) moves the pins it gave.
  repinFrames: (frameIds) => {
    const moved = new Set(frameIds);
    const { sessions, currentId } = getState();
    let changed = false;
    const next = sessions.map((session) => {
      if (session.contract !== CONTRACT || session.mode !== "walk") return session;
      let touched = false;
      const books = session.books.map((book) => {
        if (!finitePin(book.pin) || !book.pin.frame || !moved.has(book.pin.frame)) return book;
        const detection = book.detections.find((item) => item.captureId === book.pin!.frame && item.box) ??
          book.detections.find((item) => item.captureId === book.pin!.frame);
        const pin = detection && pinFor(book, detection);
        if (!pin || (pin.x === book.pin.x && pin.row === book.pin.row && pin.section === book.pin.section)) return book;
        touched = true;
        return { ...book, pin };
      });
      if (!touched) return session;
      changed = true;
      return { ...session, books };
    });
    if (!changed) return;
    setState({ sessions: next });
    persist(next, currentId);
  },
  setProgressFor: (id, progress) => {
    if (getState().currentId === id) setState({ progress });
  },
  removeSession: (id) => {
    if (id === currentWalk()) endWalk();
    const { sessions, currentId, progress } = getState();
    const next = sessions.filter((session) => session.id !== id);
    const selected = currentId === id ? next[0]?.id ?? null : currentId;
    setState({ sessions: next, currentId: selected, progress: currentId === id ? "" : progress });
    persist(next, selected);
  },
  openSession: (id) => {
    setState({ currentId: id, tab: "shelf", progress: "", answer: "" });
    persist(getState().sessions, id);
  },
  clearLocal: () => {
    endWalk();
    setState({ sessions: [], currentId: null, progress: "", answer: "" });
    persist([], null);
  },
}));

onFramesMoved((frameIds) => useShelf.getState().repinFrames(frameIds));

export function currentSession(state: State) {
  return state.sessions.find((session) => session.id === state.currentId) ?? null;
}
