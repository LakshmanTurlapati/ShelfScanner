import { useState } from "react";
import type { Book } from "../../shared/types.ts";
import { anchorsForCapture } from "./overlay/anchors";
import { layoutCallouts, markRank } from "./overlay/geometry";

export function StillCallouts({ url, books, captureId }: { url: string; books: Book[]; captureId: string }) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  const anchors = anchorsForCapture(books, captureId).filter((anchor) =>
    anchor.book.detections.some((detection) => detection.id === anchor.id && detection.photoIndex === 0),
  );
  const items = anchors
    .map((anchor) => ({ ...anchor, mark: anchor.book.mark || "·" }))
    .sort((a, b) => markRank(a.mark) - markRank(b.mark));
  const callouts = layoutCallouts(items);
  return (
    <div className="mb-4" data-testid="still-callouts">
      <div className="relative">
        <img
          src={url}
          alt="The shelf you photographed"
          className="w-full rounded-2xl"
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
        />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`}>
          {callouts.map((callout, index) => {
            const targetX = callout.targetX * size.width;
            const targetY = callout.targetY * size.height;
            const elbowX = callout.elbowX * size.width;
            const elbowY = callout.elbowY * size.height;
            const badgeX = callout.badgeX * size.width;
            const badgeY = callout.badgeY * size.height;
            const radius = Math.max(size.width, size.height) * 0.018;
            return (
              <g key={`${callout.mark}:${index}`} stroke="#1c1915" fill="#1c1915">
                <path d={`M ${targetX} ${targetY} L ${elbowX} ${elbowY} L ${badgeX} ${badgeY}`} fill="none" strokeWidth={Math.max(1.5, radius / 8)} />
                <circle cx={targetX} cy={targetY} r={radius * 0.35} />
                <circle cx={badgeX} cy={badgeY} r={radius} />
                <text x={badgeX} y={badgeY} textAnchor="middle" dominantBaseline="central" fill="#f3ecdf" stroke="none" fontSize={radius * 1.1} fontFamily="Palatino, Georgia, serif">
                  {callout.mark}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="mt-4">
        <ul className="space-y-2 text-sm">
          {items.map((item) => (
            <li key={item.id} className="flex gap-2">
              <span className="inline-grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#1c1915] text-xs text-[#f3ecdf]">{item.mark}</span>
              <span className="min-w-0 flex-1">{item.title}</span>
              {item.showRating && item.book.avgRating != null && <span>{item.book.avgRating.toFixed(2)}★</span>}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
