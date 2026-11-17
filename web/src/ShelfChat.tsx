import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Book } from "../../shared/types.ts";
import { ASK_BOOK_LIMIT, askShelf, OfflineError, reportAnswer, type ReportReason } from "./api";
import { renderMarkdown } from "./markdown";
import { useShelf } from "./store";
import { activeWalk, walkPosition } from "./walk";

function nearBottom(node: HTMLElement) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 48;
}

export function ShelfChat({ books, walkId = null }: { books: Book[]; walkId?: string | null }) {
  const answer = useShelf((state) => state.answer);
  const asking = useShelf((state) => state.asking);
  const setAnswer = useShelf((state) => state.setAnswer);
  const setAsking = useShelf((state) => state.setAsking);
  const [draft, setDraft] = useState("");
  const [asked, setAsked] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const current = useRef<AbortController | null>(null);
  const [reporting, setReporting] = useState<"closed" | "choosing" | "sending" | "sent" | "failed">("closed");

  // App keys this view by session, so leaving a shelf cancels its answer and a late chunk
  // cannot land under the next one.
  useEffect(() => () => {
    if (!current.current) return;
    current.current.abort();
    current.current = null;
    useShelf.getState().setAsking(false);
    useShelf.getState().setAnswer("");
  }, []);

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
    setReporting("closed");
    setAsking(true);
    setAnswer("");
    stick.current = true;
    current.current?.abort();
    const controller = new AbortController();
    current.current = controller;
    try {
      await askShelf(question, books, (chunk) => {
        if (current.current !== controller) return;
        setAnswer(useShelf.getState().answer + chunk);
      }, controller.signal, { walk: walkId !== null, position: walkId !== null && walkId === activeWalk() ? walkPosition() : null });
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof OfflineError ? err.message : "The shelf could not answer. Try again.");
    } finally {
      if (current.current === controller) {
        current.current = null;
        setAsking(false);
      }
    }
  }

  async function report(reason: ReportReason) {
    setReporting("sending");
    try {
      await reportAnswer({ reason, question: asked, answer });
      setReporting("sent");
    } catch {
      setReporting("failed");
    }
  }

  const finished = Boolean(asked && answer && !asking);

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
      {books.length > ASK_BOOK_LIMIT && (
        <p className="mt-1 text-xs text-[#6a584d]">
          {walkId !== null && walkId === activeWalk() && walkPosition()
            ? `Asking about the ${ASK_BOOK_LIMIT} books nearest you.`
            : walkId !== null
              ? `Asking about the ${ASK_BOOK_LIMIT} books seen last.`
              : `Asking about the first ${ASK_BOOK_LIMIT} books.`}
        </p>
      )}
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
            {answer && <div className="shelf-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(answer, asking) }} />}
            {error && <p className={`text-[#8a3b2c] ${answer ? "mt-1" : ""}`}>{answer ? `The answer stopped early. ${error}` : error}</p>}
            {finished && (
              <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-[#f1ebe4] pt-2 text-xs text-[#6a584d]">
                {reporting === "closed" && (
                  <button className="underline" type="button" onClick={() => setReporting("choosing")}>Report this answer</button>
                )}
                {(reporting === "choosing" || reporting === "failed") && (
                  <>
                    <span>{reporting === "failed" ? "That report did not send. Try again:" : "What is wrong with it?"}</span>
                    <button className="rounded-full bg-[#f1ebe4] px-2 py-1" type="button" onClick={() => void report("offensive")}>Offensive</button>
                    <button className="rounded-full bg-[#f1ebe4] px-2 py-1" type="button" onClick={() => void report("wrong")}>Wrong or made up</button>
                    <button className="underline" type="button" onClick={() => setReporting("closed")}>Cancel</button>
                  </>
                )}
                {reporting === "sending" && <span>Sending…</span>}
                {reporting === "sent" && <span role="status">Thanks. This answer was reported for review.</span>}
              </div>
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
