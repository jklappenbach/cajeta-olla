// Search provider (§12). Two backends behind one interface:
//   - "d1"      : built-in FTS5 trigram (default; substring + typo tolerance,
//                 maintained by the migration's triggers).
//   - "algolia" : the hosted, typo-tolerant index — selected when
//                 SEARCH_PROVIDER=algolia and credentials are present.
// Indexing for Algolia is push-on-publish (`indexPackage`) + rebuildable from
// D1 (`reindexAll`). D1 needs no push — its triggers keep the FTS in sync.
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

// ── provider selection ──

interface AlgoliaConfig {
  appId: string;
  apiKey: string; // admin (indexing)
  searchKey: string; // search
  index: string;
}

function algoliaConfig(env: Env): AlgoliaConfig | null {
  if ((env.SEARCH_PROVIDER ?? 'd1') !== 'algolia') return null;
  if (!env.ALGOLIA_APP_ID || !env.ALGOLIA_API_KEY) return null;
  return {
    appId: env.ALGOLIA_APP_ID,
    apiKey: env.ALGOLIA_API_KEY,
    searchKey: env.ALGOLIA_SEARCH_KEY ?? env.ALGOLIA_API_KEY,
    index: env.ALGOLIA_INDEX ?? 'packages',
  };
}

function algoliaHeaders(cfg: AlgoliaConfig, key: string) {
  return {
    'X-Algolia-Application-Id': cfg.appId,
    'X-Algolia-API-Key': key,
    'Content-Type': 'application/json',
  };
}

// ── D1 provider (FTS5 trigram) ──

function ftsQuery(q: string): string {
  const cleaned = q.replace(/"/g, '').trim();
  return cleaned ? `"${cleaned}"` : '';
}

async function searchD1(
  env: Env,
  q: string,
  page: number,
  hits: number,
): Promise<SearchResult> {
  const match = ftsQuery(q);
  if (!match) return { hits: [], page, nbHits: 0 };
  const offset = page * hits;
  const rows = await env.DB.prepare(
    `SELECT p.name AS name, p.latest_version AS version, p.description AS description,
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

// ── Algolia provider (REST, no SDK) ──

async function searchAlgolia(
  cfg: AlgoliaConfig,
  q: string,
  page: number,
  hits: number,
): Promise<SearchResult> {
  const res = await fetch(
    `https://${cfg.appId}-dsn.algolia.net/1/indexes/${encodeURIComponent(cfg.index)}/query`,
    {
      method: 'POST',
      headers: algoliaHeaders(cfg, cfg.searchKey),
      body: JSON.stringify({ query: q, page, hitsPerPage: hits }),
    },
  );
  if (!res.ok) throw new Error(`algolia query ${res.status}`);
  const data = (await res.json()) as {
    hits: { objectID: string; name?: string; version?: string; description?: string }[];
    nbHits: number;
    page: number;
  };
  return {
    hits: data.hits.map((h, i) => ({
      name: h.name ?? h.objectID,
      version: h.version ?? null,
      description: h.description ?? '',
      score: data.hits.length - i, // Algolia returns best-first
    })),
    page: data.page ?? page,
    nbHits: data.nbHits ?? data.hits.length,
  };
}

// ── public interface ──

export async function search(
  env: Env,
  q: string,
  page: number,
  hits: number,
): Promise<SearchResult> {
  const cfg = algoliaConfig(env);
  if (cfg) {
    try {
      return await searchAlgolia(cfg, q, page, hits);
    } catch {
      // Algolia hiccup → fall back to D1 so search degrades, not fails.
      return searchD1(env, q, page, hits);
    }
  }
  return searchD1(env, q, page, hits);
}

export interface IndexDoc {
  name: string;
  version: string | null;
  description: string;
  keywords: string;
}

/** Push one package into the Algolia index (no-op for D1 — triggers handle it). */
export async function indexPackage(env: Env, doc: IndexDoc): Promise<void> {
  const cfg = algoliaConfig(env);
  if (!cfg) return;
  await fetch(
    `https://${cfg.appId}.algolia.net/1/indexes/${encodeURIComponent(
      cfg.index,
    )}/${encodeURIComponent(doc.name)}`,
    {
      method: 'PUT',
      headers: algoliaHeaders(cfg, cfg.apiKey),
      body: JSON.stringify({
        objectID: doc.name,
        name: doc.name,
        version: doc.version,
        description: doc.description,
        keywords: doc.keywords,
      }),
    },
  );
}

/** Drop a package from the Algolia index (so a yanked package leaves results). */
export async function removeFromIndex(env: Env, name: string): Promise<void> {
  const cfg = algoliaConfig(env);
  if (!cfg) return;
  await fetch(
    `https://${cfg.appId}.algolia.net/1/indexes/${encodeURIComponent(
      cfg.index,
    )}/${encodeURIComponent(name)}`,
    { method: 'DELETE', headers: algoliaHeaders(cfg, cfg.apiKey) },
  );
}

/** Rebuild the Algolia index from D1 (the system of record). Returns the count
 *  pushed. No-op (returns -1) when Algolia isn't configured. */
export async function reindexAll(env: Env): Promise<number> {
  const cfg = algoliaConfig(env);
  if (!cfg) return -1;
  const rows = await env.DB.prepare(
    `SELECT name, description, keywords, latest_version FROM packages`,
  ).all<{ name: string; description: string; keywords: string; latest_version: string | null }>();
  const objects = (rows.results ?? []).map((r) => ({
    action: 'updateObject',
    body: {
      objectID: r.name,
      name: r.name,
      version: r.latest_version,
      description: r.description,
      keywords: r.keywords,
    },
  }));
  // Algolia batch endpoint — chunk to stay well under request limits.
  for (let i = 0; i < objects.length; i += 1000) {
    const requests = objects.slice(i, i + 1000);
    const res = await fetch(
      `https://${cfg.appId}.algolia.net/1/indexes/${encodeURIComponent(cfg.index)}/batch`,
      {
        method: 'POST',
        headers: algoliaHeaders(cfg, cfg.apiKey),
        body: JSON.stringify({ requests }),
      },
    );
    if (!res.ok) throw new Error(`algolia batch ${res.status}`);
  }
  return objects.length;
}
