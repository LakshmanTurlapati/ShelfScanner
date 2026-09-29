import { useState } from "react";
import type { Book } from "../../shared/types.ts";
import { Legend } from "./Legend";
import { layoutCallouts } from "./overlay/geometry";

export function StillCallouts({ url, books }: { url: string; books: Book[] }) {
  const [size, setSize] = useState({ width: 1, height: 1 });
  const callouts = layoutCallouts(
    books.filter((book) => book.box && book.mark).map((book) => ({ mark: book.mark, box: book.box! })),
  );
  return (
    <div className="mb-4">
      <div className="relative">
        <img
          src={url}
          alt="The shelf you photographed"
          className="w-full rounded-2xl"
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth || 1, height: event.currentTarget.naturalHeight || 1 })}
        />
        <svg className="pointer-events-none absolute inset-0 h-full w-full" viewBox={`0 0 ${size.width} ${size.height}`}>
          {callouts.map((callout) => {
            const targetX = callout.targetX * size.width;
            const targetY = callout.targetY * size.height;
            const elbowX = callout.elbowX * size.width;
            const elbowY = callout.elbowY * size.height;
            const badgeX = callout.badgeX * size.width;
            const badgeY = callout.badgeY * size.height;
            const radius = Math.max(size.width, size.height) * 0.018;
            return (
              <g key={callout.mark} stroke="#1c1915" fill="#1c1915">
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
        <Legend books={books} />
      </div>
    </div>
  );
}
