import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Book } from "../../shared/types.ts";
import { askShelf, OfflineError } from "./api";
import { renderMarkdown } from "./markdown";
import { useShelf } from "./store";

function nearBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
}

export function ShelfChat({ books }: { books: Book[] }) {
  const answer = useShelf((state) => state.answer);
  const asking = useShelf((state) => state.asking);
  const setAnswer = useShelf((state) => state.setAnswer);
  const setAsking = useShelf((state) => state.setAsking);
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const node = scroller.current;
    if (!node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  }, [answer, asking, error]);

  async function ask(event: FormEvent) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || !books.length || asking) return;
    setAsked(question);
    setDraft("");
    setError("");
    setAsking(true);
    setAnswer("");
    stick.current = true;
    try {
      await askShelf(question, books, (chunk) => {
        setAnswer(useShelf.getState().answer + chunk);
      });
    } catch (err) {
      setError(err instanceof OfflineError ? err.message : "The shelf could not answer. Try again.");
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="mb-3">
      <form className="flex gap-2" onSubmit={ask}>
        <input
          aria-label="Ask the shelf"
          className="row min-w-0 flex-1 px-3 py-2"
          placeholder="Ask the shelf"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button className="rounded-xl bg-[#ff6b35] px-3 py-2 font-semibold text-[#1f1a17]" type="submit" disabled={asking || !books.length}>
          Ask
        </button>
      </form>
      {(asked || answer || asking || error) && (
        <div
          ref={scroller}
          className="mt-2 max-h-72 space-y-2 overflow-y-auto pr-1"
          onScroll={(event) => {
            stick.current = nearBottom(event.currentTarget);
          }}
        >
          {asked && <p className="ml-10 break-words rounded-2xl bg-[#1f1a17] px-3 py-2 text-sm leading-6 text-[#fffaf6]">{asked}</p>}
          <div className="mr-10 rounded-2xl border border-[#eadfd4] bg-white px-3 py-2 text-sm leading-6 text-[#1f1a17] [overflow-wrap:anywhere]">
            {error ? (
              <p className="text-[#8a3b2c]">{error}</p>
            ) : (
              answer && <div className="shelf-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer, asking) }} />
            )}
            {asking && (
              <p className="mt-1 flex gap-1" aria-label="Writing an answer">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a58e5f]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a58e5f] [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[#a58e5f] [animation-delay:300ms]" />
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
