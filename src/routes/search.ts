// GET /v2/search?q=&page=&hits= (§12). Paged full-text search returning a
// provider-stable shape: { hits:[{name,version,description,score}], page, nbHits }.
import { Hono } from 'hono';
import type { Env } from '../types';
import { search as runSearch } from '../lib/search-index';
import { jsonError } from '../lib/http';

export const search = new Hono<{ Bindings: Env }>();

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
