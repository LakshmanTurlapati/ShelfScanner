import { useShelf } from "./store";

const CHUNK = 40;

function isbnDigits(value: string) {
  return value.replace(/\D/g, "");
}

function validIsbn13(value: string) {
  const digits = isbnDigits(value);
  if (digits.length !== 13) return false;
  const sum = [...digits].reduce((total, char, index) => total + Number(char) * (index % 2 ? 3 : 1), 0);
  return sum % 10 === 0;
}

export function coverImageUrl(coverId: number | null | undefined) {
  if (typeof coverId !== "number" || !Number.isInteger(coverId) || coverId <= 0) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-M.jpg`;
}

type CoverItem = { isbn: string; coverId: number | null };

async function requestCovers(isbns: string[]): Promise<CoverItem[]> {
  const collected: CoverItem[] = [];
  for (let index = 0; index < isbns.length; index += CHUNK) {
    const res = await fetch("/api/covers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isbns: isbns.slice(index, index + CHUNK) }),
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { items?: CoverItem[] };
    if (Array.isArray(body.items)) collected.push(...body.items);
  }
  return collected;
}

// Writes a positive cover id or an explicit miss. A failed request leaves the book unset.
export async function fillCovers(sessionId: string) {
  const session = useShelf.getState().sessions.find((item) => item.id === sessionId);
  if (!session || session.contract !== 1) return;
  const pending = session.books.filter((book) => book.coverId === undefined && book.isbn13 && validIsbn13(book.isbn13));
  if (!pending.length) return;
  const isbns = [...new Set(pending.map((book) => isbnDigits(book.isbn13!)))];
  let items: CoverItem[] = [];
  try {
    items = await requestCovers(isbns);
  } catch {
    return;
  }
  const byIsbn = new Map(items.map((item) => [item.isbn, item.coverId]));
  for (const book of pending) {
    const isbn = isbnDigits(book.isbn13!);
    if (!byIsbn.has(isbn)) continue;
    const coverId = byIsbn.get(isbn);
    const legal = coverId === null || (typeof coverId === "number" && Number.isInteger(coverId) && coverId > 0);
    if (!legal) continue;
    useShelf.getState().patchBookFor(sessionId, book.key, { coverId });
  }
}
