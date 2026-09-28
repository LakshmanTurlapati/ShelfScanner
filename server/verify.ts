import { token_set_ratio } from "fuzzball";
import type { BookFactsInput } from "../shared/schemas.ts";
import type { Flag } from "../shared/types.ts";
import { norm } from "../web/src/pipeline/dedup.ts";

export type ChatResponse = {
  choices?: Array<{
    message?: {
      content?: string | null;
      annotations?: Array<{ type?: string; url_citation?: { url?: string } }>;
    };
  }>;
  usage?: { server_tool_use?: { web_search_requests?: number } };
};

const pageKey = (u: string) => {
  try {
    const x = new URL(u);
    return x.hostname.replace(/^www\./, "") + x.pathname.replace(/\/$/, "");
  } catch {
    return u;
  }
};

export const isValidIsbn13 = (s: string) => {
  const d = s.replace(/\D/g, "");
  if (d.length !== 13) return false;
  return [...d].reduce((sum, c, i) => sum + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
};

export function verify(facts: BookFactsInput, res: ChatResponse, spineTitle: string) {
  const flags: Flag[] = [];
  const cited = new Set(
    (res.choices?.[0]?.message?.annotations ?? [])
      .filter((a) => a.type === "url_citation" && a.url_citation?.url)
      .map((a) => pageKey(a.url_citation!.url!)),
  );
  const searched = (res.usage?.server_tool_use?.web_search_requests ?? 0) > 0;
  if (facts.avg_rating !== null && (!searched || !facts.rating_url || !cited.has(pageKey(facts.rating_url)))) {
    facts.avg_rating = null;
    facts.ratings_count = null;
    flags.push("unverified_rating");
  }
  if (facts.isbn13 && !isValidIsbn13(facts.isbn13)) {
    facts.isbn13 = null;
    flags.push("bad_isbn");
  }
  if (facts.canonical_title && token_set_ratio(norm(facts.canonical_title), norm(spineTitle)) < 70) {
    flags.push("possible_mismatch");
  }
  return { facts, flags };
}
