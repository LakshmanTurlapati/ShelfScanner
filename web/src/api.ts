import type { BookFactsInput } from "../../shared/schemas.ts";
import type { Flag } from "../../shared/types.ts";
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

async function send(input: string, init: RequestInit, retry = true) {
  await ensureOnline();
  const target = apiUrl(input);
  const res = await fetch(target, init);
  if (retry && (res.status === 502 || res.status === 504)) {
    const retry = await fetch(target, init);
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
  }, false);
  return (await res.json()) as EnrichResponse;
}

export async function quickFacts(items: Array<{ key: string; title: string; author: string | null }>) {
  const res = await send("/api/quick-facts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  }, false);
  return (await res.json()) as { items: QuickFactsItem[] };
}

export async function embedBooks(items: Array<{ key: string; text: string }>) {
  const res = await send("/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return (await res.json()) as { items: Array<{ key: string; embedding: number[] }> };
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

// The packaged app does not use CapacitorHttp for this call. That client waits
// for the whole body, so the answer would appear in one piece.
async function streamNatively(url: string, body: string, onText: (chunk: string) => void) {
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    const requestId = crypto.randomUUID();
    let sent = false;
    const handle = await ShelfNative.addListener("chunk", (event) => {
      if (event.requestId !== requestId || !event.text) return;
      sent = true;
      onText(event.text);
    });
    try {
      await ShelfNative.stream({ url, body, requestId });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Ask failed.";
      if (!sent && attempt === 1 && (message.includes("502") || message.includes("504"))) continue;
      throw new Error(message);
    } finally {
      await handle.remove();
    }
  }
}

export async function askShelf(question: string, books: unknown[], onText: (chunk: string) => void) {
  await ensureOnline();
  const body = JSON.stringify({ question, books });
  const url = apiUrl("/api/ask");
  if (isNativeApp()) {
    await streamNatively(url, body, onText);
    return;
  }
  const res = await send("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  await readTextStream(res, onText);
}
