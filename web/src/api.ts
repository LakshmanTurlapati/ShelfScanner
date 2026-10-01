import type { BookFactsInput } from "../../shared/schemas.ts";
import type { Flag } from "../../shared/types.ts";

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

async function send(input: string, init: RequestInit, retry = true) {
  const res = await fetch(input, init);
  if (retry && (res.status === 502 || res.status === 504)) {
    const retry = await fetch(input, init);
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
    body: blob,
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
  form.append("image", image, "frame.jpg");
  form.append("meta", JSON.stringify(meta));
  await fetch("/api/frames", { method: "POST", body: form });
}

export async function askShelf(question: string, books: unknown[], onText: (chunk: string) => void) {
  const res = await send("/api/ask", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question, books }),
  });
  const reader = res.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onText(decoder.decode(value, { stream: true }));
  }
}
