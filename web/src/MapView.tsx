import { useEffect, useState, type ComponentType } from "react";
import type { Book } from "../../shared/types.ts";
import { GENRE_LABELS } from "../../shared/types.ts";
import { knnGraph, nearest } from "./pipeline/graph";

type ForceGraphComponent = ComponentType<{
  graphData: ReturnType<typeof knnGraph>;
  nodeAutoColorBy: string;
  nodeLabel: string;
  nodeVal: (node: { score: number | null }) => number;
  linkWidth: (link: { value: number }) => number;
  onNodeClick: (node: { id: string }) => void;
  width: number;
  height: number;
}>;

export function MapView({ books }: { books: Book[] }) {
  const graph = knnGraph(books);
  const [Graph, setGraph] = useState<ForceGraphComponent | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void import("react-force-graph-2d").then((mod) => {
      if (alive) setGraph(() => mod.default as ForceGraphComponent);
    });
    return () => {
      alive = false;
    };
  }, []);

  const neighbors = selected ? nearest(books, selected) : [];
  const byKey = new Map(books.map((book) => [book.key, book]));

  return (
    <section>
      <div className="card overflow-hidden">
        {Graph && graph.nodes.length > 0 ? (
          <Graph
            graphData={graph}
            nodeAutoColorBy="genre"
            nodeLabel="title"
            nodeVal={(node) => (node.score == null ? 1 : 2 + node.score)}
            linkWidth={(link) => 0.4 + link.value}
            onNodeClick={(node) => setSelected(node.id)}
            width={Math.min(720, window.innerWidth - 32)}
            height={420}
          />
        ) : (
          <p className="p-4 text-sm text-[#6a584d]">The map appears after embeddings come back.</p>
        )}
      </div>
      {selected && (
        <div className="card mt-3 p-4">
          <h2 className="display text-xl">{byKey.get(selected)?.canonicalTitle ?? selected}</h2>
          <p className="mt-1 text-sm text-[#6a584d]">Similar on this shelf</p>
          <ul className="mt-2 space-y-1 text-sm">
            {neighbors.map((item) => (
              <li key={item.key}>{byKey.get(item.key)?.canonicalTitle ?? item.key}</li>
            ))}
          </ul>
        </div>
      )}
      <h2 className="mono mb-2 mt-4 text-xs font-semibold uppercase tracking-[0.06em] text-[#6a584d]">Nearest neighbors</h2>
      <ul className="space-y-2">
        {books.filter((book) => book.embedding).map((book) => (
          <li key={book.key} className="row px-3 py-2 text-sm">
            <span className="font-medium">{book.canonicalTitle ?? book.key}</span>
            <span className="text-[#6a584d]"> · {book.primaryGenre ? GENRE_LABELS[book.primaryGenre] : "Unsorted"}</span>
            <div>{nearest(books, book.key).map((item) => byKey.get(item.key)?.canonicalTitle ?? item.key).join(", ") || "No neighbors yet"}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}
