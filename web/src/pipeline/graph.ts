import type { Book } from "../../../shared/types.ts";

const unit = (v: number[]) => {
  const n = Math.hypot(...v);
  if (n === 0) return v;
  return v.map((x) => x / n);
};

export function knnGraph(books: Book[], k = 3) {
  const ready = books.filter((b) => b.embedding && b.embedding.length > 0);
  const vs = ready.map((b) => unit(b.embedding!));
  const sim = vs.map((a) => vs.map((b) => a.reduce((sum, x, i) => sum + x * b[i], 0)));
  const pairs = sim.flatMap((row, i) => row.filter((_, j) => j > i)).sort((a, b) => a - b);
  const median = pairs[Math.floor(pairs.length / 2)] ?? 0;
  const links = new Map<string, { source: string; target: string; value: number }>();
  ready.forEach((b, i) => {
    sim[i]
      .map((s, j) => ({ s, j }))
      .filter((x) => x.j !== i && x.s >= median)
      .sort((x, y) => y.s - x.s)
      .slice(0, k)
      .forEach(({ s, j }) => {
        const [p, q] = [b.key, ready[j].key].sort();
        links.set(`${p}|${q}`, { source: p, target: q, value: s });
      });
  });
  return {
    nodes: ready.map((b) => ({ id: b.key, genre: b.primaryGenre, score: b.score, title: b.canonicalTitle ?? b.key })),
    links: [...links.values()],
  };
}

export function nearest(books: Book[], key: string, k = 3) {
  const graph = knnGraph(books, k);
  return graph.links
    .filter((link) => link.source === key || link.target === key)
    .map((link) => ({
      key: link.source === key ? link.target : link.source,
      value: link.value,
    }))
    .sort((a, b) => b.value - a.value)
    .slice(0, k);
}
