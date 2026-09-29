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
  }>;
};

export type EnrichResponse = {
  facts: BookFactsInput;
  flags: Flag[];
  cached: boolean;
  embedding?: number[];
};

async function send(input: string, init: RequestInit) {
  const res = await fetch(input, init);
  if (res.status === 502 || res.status === 504) {
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
  });
  return (await res.json()) as EnrichResponse;
}

export async function embedBooks(items: Array<{ key: string; text: string }>) {
  const res = await send("/api/embed", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ items }),
  });
  return (await res.json()) as { items: Array<{ key: string; embedding: number[] }> };
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
