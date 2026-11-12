import { useState } from "react";
import { GENRES, GENRE_LABELS, type Genre } from "../../shared/types.ts";
import { saveProfile, skipProfile } from "./profile";
import { picksFrom, QUIZ_PAIRS } from "./quiz";

export function ProfileGate({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [genres, setGenres] = useState<Genre[]>([]);
  const [choices, setChoices] = useState<Record<number, string>>({});
  const [error, setError] = useState("");

  function toggle(genre: Genre) {
    setGenres((current) => (current.includes(genre) ? current.filter((item) => item !== genre) : [...current, genre]));
  }

  async function skip() {
    await skipProfile();
    onDone();
  }

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Add a name, or skip this for now.");
      return;
    }
    await saveProfile({
      name: trimmed,
      genres,
      picks: picksFrom(QUIZ_PAIRS.map((_, index) => choices[index])),
    });
    onDone();
  }

  return (
    <div className="fixed inset-0 z-[70] overflow-auto bg-[#fffaf6] px-4 py-8 text-[#1f1a17]" role="dialog" aria-modal="true" aria-labelledby="profile-title">
      <div className="mx-auto flex max-w-3xl flex-col gap-4">
        <h2 id="profile-title" className="display text-[30px] leading-none">Who is this shelf for?</h2>
        <p className="text-sm text-[#6a584d]">This stays on this phone. You can skip it.</p>
        <label className="block text-sm">
          Name
          <input className="row mt-1 w-full px-3 py-2" value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm">Genres you want more of</legend>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((genre) => (
              <button
                key={genre}
                className={`rounded-full px-3 py-1 text-sm ${genres.includes(genre) ? "bg-[#1f1a17] text-[#fffaf6]" : "bg-[#f1ebe4]"}`}
                type="button"
                aria-pressed={genres.includes(genre)}
                onClick={() => toggle(genre)}
              >
                {GENRE_LABELS[genre]}
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-4">
          <legend className="text-sm">Which would you pick up?</legend>
          {QUIZ_PAIRS.map((pair, index) => (
            <div key={pair[0]} className="flex flex-wrap gap-2">
              {pair.map((title) => (
                <button
                  key={title}
                  className={`rounded-full px-3 py-1 text-sm ${choices[index] === title ? "bg-[#ff6b35]" : "bg-[#f1ebe4]"}`}
                  type="button"
                  aria-pressed={choices[index] === title}
                  onClick={() => setChoices((current) => ({ ...current, [index]: title }))}
                >
                  {title}
                </button>
              ))}
            </div>
          ))}
        </fieldset>
        {error && <p role="alert" className="text-sm text-[#dc2626]">{error}</p>}
        <div className="flex gap-2">
          <button className="rounded-full border border-[#1f1a17] px-3 py-1 text-sm" type="button" onClick={() => void skip()}>Skip for now</button>
          <button className="rounded-full bg-[#1f1a17] px-3 py-1 text-sm text-[#fffaf6]" type="button" onClick={() => void save()}>Save profile</button>
        </div>
      </div>
    </div>
  );
}
