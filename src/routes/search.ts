// GET /v2/search?q=&page=&hits= (§12). Paged full-text search returning a
// provider-stable shape: { hits:[{name,version,description,score}], page, nbHits }.
import { Hono } from 'hono';
import type { Env } from '../types';
import { search as runSearch, reindexAll } from '../lib/search-index';
import { authenticatePublish } from '../lib/auth';
import { jsonError } from '../lib/http';

export const search = new Hono<{ Bindings: Env }>();

// Rebuild the Algolia index from D1 (§12). Admin/publish auth. No-op (indexed:
// -1) when Algolia isn't configured — D1 FTS needs no rebuild.
search.post('/v2/reindex', async (c) => {
  const auth = await authenticatePublish(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');
  try {
    const indexed = await reindexAll(c.env);
    return c.json({ indexed, provider: indexed < 0 ? 'd1' : 'algolia' });
  } catch (e) {
    return jsonError(c, 502, 'reindex failed', { hint: String(e) });
  }
});

search.get('/v2/search', async (c) => {
  const q = c.req.query('q') ?? '';
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0', 10) || 0);
  const hits = Math.min(100, Math.max(1, parseInt(c.req.query('hits') ?? '20', 10) || 20));
  if (!q.trim()) {
    // Empty query is a valid request that yields an empty result set (the UI
    // empty-state). Not an error.
    return c.json({ hits: [], page, nbHits: 0 });
  }
  try {
    const result = await runSearch(c.env, q, page, hits);
    return c.json(result);
  } catch (e) {
    return jsonError(c, 500, 'search failed', { hint: String(e) });
  }
});
