// Search provider (§12). Default "d1" uses the FTS5 trigram mirror, which
// gives substring + typo-tolerant matching without spellfix1. "algolia"
// (typo-tolerant by default) is the production index; it is not wired in
// the local/MVP build and falls back to d1.
import type { Env } from '../types';

export interface SearchHit {
  name: string;
  version: string | null;
  description: string;
  score: number;
}

export interface SearchResult {
  hits: SearchHit[];
  page: number;
  nbHits: number;
}

// FTS5 query: AND the query's trigrams as a phrase-ish match. We quote the
// raw query so punctuation in the term can't inject FTS operators.
function ftsQuery(q: string): string {
  const cleaned = q.replace(/"/g, '').trim();
  if (!cleaned) return '';
  return `"${cleaned}"`;
}

async function searchD1(
  env: Env,
  q: string,
  page: number,
  hits: number,
): Promise<SearchResult> {
  const match = ftsQuery(q);
  if (!match) {
    return { hits: [], page, nbHits: 0 };
  }
  const offset = page * hits;

  // bm25() is ascending (lower = better); flip the sign so a larger `score`
  // means a better hit, matching the stable result shape across providers.
  const rows = await env.DB.prepare(
    `SELECT p.name AS name,
            p.latest_version AS version,
            p.description AS description,
            bm25(packages_fts) AS rank
       FROM packages_fts
       JOIN packages p ON p.rowid = packages_fts.rowid
      WHERE packages_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(match, hits, offset)
    .all<{ name: string; version: string | null; description: string; rank: number }>();

  const countRow = await env.DB.prepare(
    `SELECT count(*) AS n FROM packages_fts WHERE packages_fts MATCH ?`,
  )
    .bind(match)
    .first<{ n: number }>();

  return {
    hits: (rows.results ?? []).map((r) => ({
      name: r.name,
      version: r.version,
      description: r.description ?? '',
      score: -r.rank,
    })),
    page,
    nbHits: countRow?.n ?? 0,
  };
}

export async function search(
  env: Env,
  q: string,
  page: number,
  hits: number,
): Promise<SearchResult> {
  // SEARCH_PROVIDER=algolia would route here once configured; the local
  // build always uses D1.
  return searchD1(env, q, page, hits);
}
