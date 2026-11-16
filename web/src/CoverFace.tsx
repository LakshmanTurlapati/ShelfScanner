import { useState } from "react";
import type { Book } from "../../shared/types.ts";
import { coverLooksEmpty, coverSrc, coverSources, noteCoverError, noteCoverMiss, type CoverAttempt } from "./covers";

function titleOf(book: Book) {
  return book.canonicalTitle ?? book.detections[0]?.title ?? "Unread spine";
}

export function CoverPlaceholder({ title }: { title: string }) {
  return (
    <span className="flex aspect-[2/3] w-full flex-col items-center justify-end gap-2 overflow-hidden rounded-lg bg-[#f1ebe4] p-2">
      <img src="/logo.svg" alt="" className="w-10" />
      <span className="line-clamp-4 text-balance text-center text-sm leading-4">{title}</span>
    </span>
  );
}

export function CoverFace({ book, className }: { book: Book; className: string }) {
  const sources = coverSources(book);
  const [attempt, setAttempt] = useState<CoverAttempt>({ index: 0, retries: 0, failed: false });
  const src = coverSrc(sources, attempt);
  if (!src) return <CoverPlaceholder title={titleOf(book)} />;
  return (
    <img
      className={className}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      onLoad={(event) => {
        if (coverLooksEmpty(event.currentTarget)) setAttempt((current) => noteCoverMiss(sources, current));
      }}
      onError={() => setAttempt((current) => noteCoverError(sources, current))}
    />
  );
}
