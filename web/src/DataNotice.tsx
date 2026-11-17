import { useState } from "react";
import { PRIVACY_URL } from "./legal";

// Shown once, before the camera first opens. The app cannot read a shelf without sending
// pictures to the server and its AI models, so agreeing is required to continue.
export function DataNotice({ onAgree }: { onAgree: () => void }) {
  const [declined, setDeclined] = useState(false);
  return (
    <div
      className="fixed inset-0 z-[80] overflow-auto bg-[#fffaf6] px-4 py-8 text-[#1f1a17]"
      style={{ paddingTop: "calc(2rem + env(safe-area-inset-top, 0px))", paddingBottom: "calc(2rem + env(safe-area-inset-bottom, 0px))" }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="notice-title"
    >
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <h2 id="notice-title" className="display text-[30px] leading-none">Before the camera opens</h2>
        <p className="text-sm leading-6">Shelf Scanner reads spines with AI. To do that:</p>
        <ul className="list-disc space-y-2 pl-5 text-sm leading-6">
          <li>
            <strong>Pictures of the shelf go to our server</strong>, which sends them to third-party AI models through OpenRouter to read
            the titles.
          </li>
          <li>Titles it reads are looked up on Goodreads, Open Library, and Google Books.</li>
          <li>
            <strong>Some camera frames are kept on our server</strong> (the latest 2,000) to improve reading, with the labels shown and
            whether each was marked For you.
          </li>
          <li>Questions you ask the shelf go to an AI model with the books on that shelf.</li>
          <li>Your taste quiz and saved shelves stay on this phone.</li>
        </ul>
        <p className="text-sm text-[#6a584d]">
          Point the camera at shelves, not people. Details are in the{" "}
          <a className="underline" href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">privacy policy</a>.
        </p>
        {declined && (
          <p role="alert" className="text-sm text-[#8a3b2c]">
            Shelf Scanner can&apos;t read a shelf without sending pictures to be read. You can agree whenever you are ready.
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            className="rounded-full border border-[#1f1a17] px-3 py-1 text-sm"
            type="button"
            onClick={() => setDeclined(true)}
          >
            Not now
          </button>
          <button className="rounded-full bg-[#1f1a17] px-3 py-1 text-sm text-[#fffaf6]" type="button" onClick={onAgree}>
            Agree and continue
          </button>
        </div>
      </div>
    </div>
  );
}
