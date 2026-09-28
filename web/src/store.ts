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
  setProgress: (progress: string) => void;
  setAnswer: (answer: string) => void;
  setAsking: (asking: boolean) => void;
  beginSession: (photoCount: number) => string;
  setBooks: (books: Book[]) => void;
  patchBook: (key: string, patch: Partial<Book>) => void;
  openSession: (id: string) => void;
  clearLocal: () => void;
};

function persist(sessions: Session[], currentId: string | null) {
  void set(STORE_KEY, { sessions, currentId });
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
  setProgress: (progress) => setState({ progress }),
  setAnswer: (answer) => setState({ answer }),
  setAsking: (asking) => setState({ asking }),
  beginSession: (photoCount) => {
    const id = crypto.randomUUID();
    const session: Session = { id, createdAt: new Date().toISOString(), photoCount, books: [] };
    const sessions = [session, ...getState().sessions];
    setState({ sessions, currentId: id, tab: "shelf", answer: "", progress: "" });
    persist(sessions, id);
    return id;
  },
  setBooks: (books) => {
    const { sessions, currentId } = getState();
    const next = sessions.map((session) => (session.id === currentId ? { ...session, books } : session));
    setState({ sessions: next });
    persist(next, currentId);
  },
  patchBook: (key, patch) => {
    const { sessions, currentId } = getState();
    const next = sessions.map((session) =>
      session.id === currentId
        ? { ...session, books: session.books.map((book) => (book.key === key ? { ...book, ...patch } : book)) }
        : session,
    );
    setState({ sessions: next });
    persist(next, currentId);
  },
  openSession: (id) => {
    setState({ currentId: id, tab: "shelf" });
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
