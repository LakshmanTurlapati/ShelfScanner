import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Book, Session } from "../shared/types.ts";
import { fetchWithin, TimeoutError } from "../web/src/api.ts";
import { onBack, popBack } from "../web/src/back-stack.ts";
import { mapLabel } from "../web/src/MapView.tsx";
import { enrichOne } from "../web/src/scan.ts";
import { capSessions, MAX_SESSIONS, useShelf } from "../web/src/store.ts";

const saved = vi.hoisted(() => ({ value: undefined as unknown }));

vi.mock("idb-keyval", () => ({
  get: vi.fn(async () => saved.value),
  set: vi.fn(async () => undefined),
  del: vi.fn(async () => undefined),
}));

function book(key: string): Book {
  return {
    key,
    detections: [{ shelfRow: 1, position: 1, strip: 1, spineText: key, title: key, author: null, legible: true, confidence: 0.9, callNumber: null, sticker: null, box: null, stripCenter: null }],
    status: "done",
    canonicalTitle: key,
    authors: [],
    firstPublishedYear: null,
    primaryGenre: null,
    secondaryGenres: [],
    summary: null,
    avgRating: null,
    ratingsCount: null,
    ratingSource: null,
    ratingUrl: null,
    isbn13: null,
    flags: [],
    score: null,
    mark: "A",
    box: null,
  };
}

function session(id: string, createdAt: string): Session {
  return { id, createdAt, photoCount: 1, books: [], contract: 1, mode: "walk" };
}

beforeEach(() => {
  saved.value = undefined;
  useShelf.setState({ ready: false, sessions: [], currentId: null, progress: "", answer: "", asking: false });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("release fixes", () => {
  it("shows Retry after a failed edit instead of staying on Looking it up", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("enrichment failed", { status: 502 })));
    const id = useShelf.getState().beginSession(1);
    useShelf.getState().setBooksFor(id, [book("hobbit")]);
    await enrichOne("hobbit", "The Hobbit", "Tolkien");
    const stored = useShelf.getState().sessions[0].books[0];
    expect(stored.status).toBe("error");
    expect(stored.error).toBe("502");
  });

  it("keeps a shelf started before the saved ones loaded, and the saved ones too", async () => {
    saved.value = { sessions: [session("old", "2026-01-01T00:00:00.000Z")], currentId: "old" };
    const id = useShelf.getState().beginSession(1);
    await useShelf.getState().hydrate();
    const state = useShelf.getState();
    expect(state.sessions.map((item) => item.id)).toEqual([id, "old"]);
    expect(state.currentId).toBe(id);
  });

  it("keeps the newest shelves and never drops the open one", () => {
    const many = Array.from({ length: MAX_SESSIONS + 5 }, (_, i) => session(`s${i}`, new Date(Date.UTC(2026, 0, 1 + i)).toISOString()));
    const kept = capSessions(many, "s0");
    expect(kept).toHaveLength(MAX_SESSIONS);
    expect(kept.some((item) => item.id === "s0")).toBe(true);
    expect(kept.some((item) => item.id === `s${MAX_SESSIONS + 4}`)).toBe(true);
    expect(kept.some((item) => item.id === "s1")).toBe(false);
  });

  it("resets the answer when another shelf opens", () => {
    useShelf.setState({ answer: "Old answer", sessions: [session("a", "2026-01-01T00:00:00.000Z")] });
    useShelf.getState().openSession("a");
    expect(useShelf.getState().answer).toBe("");
  });

  it("writes a map label as text, not markup", () => {
    expect(mapLabel({ title: `<img src=x onerror="alert(1)">` })).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("frees the UI when a request never answers", async () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => undefined)));
    await expect(fetchWithin("https://example.test/api", {}, 20)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("closes the newest sheet first on back", () => {
    const closed: string[] = [];
    const first = onBack(() => closed.push("first"));
    onBack(() => closed.push("second"));
    expect(popBack()).toBe(true);
    first();
    expect(popBack()).toBe(false);
    expect(closed).toEqual(["second"]);
  });
});
