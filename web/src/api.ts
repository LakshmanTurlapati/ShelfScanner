import type { BookFactsInput } from "../../shared/schemas.ts";
import type { Book, Flag } from "../../shared/types.ts";
import { isNativeApp, ShelfNative } from "./native.ts";

export type SpineResponse = {
  spines: Array<{
    shelf_row: number;
    position: number;
    spine_text: string;
    title: string;
    author: string | null;
    legible: boolean;
    confidence: number;
    call_number: string | null;
    sticker: string | null;
    x?: number;
    y?: number;
    w?: number;
    h?: number;
    placement?: "matched" | "unmatched-text" | "unmatched-box" | "ambiguous";
  }>;
};

export type EnrichResponse = {
  facts: BookFactsInput;
  flags: Flag[];
  cached: boolean;
  embedding?: number[];
};

export type QuickFacts = Pick<BookFactsInput, "matched" | "canonical_title" | "authors" | "avg_rating" | "ratings_count" | "rating_url"> & {
  rating_source: "goodreads";
};

export type QuickFactsItem =
  | { key: string; verified: true; facts: BookFactsInput | null; flags: Flag[] }
  | { key: string; verified: false; facts: QuickFacts | null; flags: Flag[] };

/** Packaged Android builds set VITE_API_BASE. The browser app keeps same-origin paths. */
export function apiUrl(path: string, base = import.meta.env.VITE_API_BASE ?? "") {
  const root = String(base).replace(/\/$/, "");
  return `${root}${path.startsWith("/") ? path : `/${path}`}`;
}

// CapacitorHttp keeps a File body and drops a plain Blob (it arrives as {}).
export function jpegFile(blob: Blob, name: string) {
  if (blob instanceof File) return blob;
  return new File([blob], name, { type: blob.type || "image/jpeg" });
}

export class OfflineError extends Error {
  constructor() {
    super("You are offline. Try again when you have a connection.");
    this.name = "OfflineError";
  }
}

function assertOnline() {
  if (typeof navigator !== "undefined" && navigator.onLine === false) throw new OfflineError();
}

async function ensureOnline() {
  if (isNativeApp()) {
    try {
      const status = await ShelfNative.isOnline();
      if (!status.online) throw new OfflineError();
      return;
    } catch (error) {
      if (error instanceof OfflineError) throw error;
    }
  }
  assertOnline();
}

export class TimeoutError extends Error {
  constructor() {
    super("The server took too long to answer. Try again.");
    this.name = "TimeoutError";
  }
}

// The packaged app's fetch is CapacitorHttp, which ignores AbortSignal, so the timer is what
// frees the UI there. In a browser the signal also cancels the request itself.
export async function fetchWithin(target: string, init: RequestInit, ms: number) {
  const signal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(ms) : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError()), ms);
  });
  try {
    return await Promise.race([fetch(target, { ...init, signal: init.signal ?? signal }), expired]);
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") throw new TimeoutError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

async function send(input: string, init: RequestInit, retry = true, timeoutMs = DEFAULT_TIMEOUT_MS) {
  await ensureOnline();
  const target = apiUrl(input);
  const res = await fetchWithin(target, init, timeoutMs);
  if (retry && (res.status === 502 || res.status === 504)) {
    const retry = await fetchWithin(target, init, timeoutMs);
    if (!retry.ok) throw new Error(`${retry.status}`);
    return retry;
  }
  if (!res.ok) throw new Error(`${res.status}`);
  return res;
}

export async function readStrip(blob: Blob, strip: number, of: number) {
  const res = await send(`/api/read-strip?strip=${strip}&of=${of}`, {
    method: "POST",
    headers: { "content-type": "image/jpeg" },
    body: jpegFile(blob, "strip.jpg"),
  });
  return (await res.json()) as SpineResponse;
}

export async function enrichBook(input: { title: string; author: string | null; callNumber: string | null }) {
  const res = await send("/api/enrich", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }, false, 90_000);
  return (await res.json()) as EnrichResponse;
}

export async function quickFacts(items: Array<{ key: string; title: string; author: string | null }>) {
  const res = await send("/api/quick-facts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }, false, 20_000);
  return (await res.json()) as { items: QuickFactsItem[] };
}

export async function embedBooks(items: Array<{ key: string; text: string }>) {
  const res = await send("/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }, true, 30_000);
  return (await res.json()) as { items: Array<{ key: string; embedding: number[] }> };
}

export type ReportReason = "offensive" | "wrong";

export async function reportAnswer(input: { reason: ReportReason; question: string; answer: string }) {
  await send("/api/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ reason: input.reason, question: input.question.slice(0, 500), answer: input.answer.slice(0, 8000) }),
  }, false, 20_000);
}

export async function saveFrame(image: Blob, meta: unknown) {
  const form = new FormData();
  form.append("image", jpegFile(image, "frame.jpg"), "frame.jpg");
  form.append("meta", JSON.stringify(meta));
  await fetch(apiUrl("/api/frames"), { method: "POST", body: form });
}

async function readTextStream(res: Response, onText: (chunk: string) => void) {
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onText(decoder.decode(value, { stream: true }));
  }
}

export class CancelledError extends Error {
  constructor() {
    super("cancelled");
    this.name = "AbortError";
  }
}

// The packaged app does not use CapacitorHttp for this call. That client waits
// for the whole body, so the answer would appear in one piece.
async function streamNatively(url: string, body: string, onText: (chunk: string) => void, signal?: AbortSignal) {
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    if (signal?.aborted) throw new CancelledError();
    const requestId = crypto.randomUUID();
    let sent = false;
    const handle = await ShelfNative.addListener("chunk", (event) => {
      if (event.requestId !== requestId || !event.text || signal?.aborted) return;
      sent = true;
      onText(event.text);
    });
    const abort = () => void ShelfNative.cancel({ requestId }).catch(() => undefined);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      await ShelfNative.stream({ url, body, requestId });
      return;
    } catch (error) {
      if (signal?.aborted) throw new CancelledError();
      const message = error instanceof Error ? error.message : "Ask failed.";
      if (!sent && attempt === 1 && (message.includes("502") || message.includes("504"))) continue;
      throw new Error(message);
    } finally {
      signal?.removeEventListener("abort", abort);
      await handle.remove();
    }
  }
}

// The server's shelfRecords reads only these fields. Sending whole books carried each
// 1,536-number embedding and passed the 256 KB body limit at about a dozen books.
export const ASK_BOOK_LIMIT = 200;

export function askBooks(books: readonly Book[]) {
  return books.slice(0, ASK_BOOK_LIMIT).map((book) => ({
    canonicalTitle: book.canonicalTitle ?? null,
    detections: book.detections[0]?.title ? [{ title: book.detections[0].title }] : [],
    authors: book.authors,
    primaryGenre: book.primaryGenre ?? null,
    secondaryGenres: book.secondaryGenres ?? [],
    summary: book.summary ?? null,
    avgRating: book.avgRating ?? null,
  }));
}

export async function askShelf(question: string, books: readonly Book[], onText: (chunk: string) => void, signal?: AbortSignal) {
  await ensureOnline();
  const body = JSON.stringify({ question, books: askBooks(books) });
  const url = apiUrl("/api/ask");
  if (isNativeApp()) {
    await streamNatively(url, body, onText, signal);
    return;
  }
  const res = await send("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    signal,
  });
  await readTextStream(res, onText);
}
