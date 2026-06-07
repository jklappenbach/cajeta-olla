// GET /v2/packages?page=&hits= — catalog index for the UI's library-API
// browse page. Not part of the build-tool wire protocol; a convenience read
// surface for the registry web UI.
import { Hono } from 'hono';
import type { Env } from '../types';
import { listPackages, getPackage, getVersionStrings } from '../lib/catalog';
import { jsonError } from '../lib/http';

export const packages = new Hono<{ Bindings: Env }>();

packages.get('/v2/packages', async (c) => {
  const page = Math.max(0, parseInt(c.req.query('page') ?? '0', 10) || 0);
  const hits = Math.min(200, Math.max(1, parseInt(c.req.query('hits') ?? '50', 10) || 50));
  const result = await listPackages(c.env, page, hits);
  return c.json(result);
});

// GET /v2/package/:name — detail (metadata + version list) for the UI's
// result-detail view, in one round trip.
packages.get('/v2/package/:name', async (c) => {
  const name = c.req.param('name');
  const pkg = await getPackage(c.env, name);
  if (!pkg) return jsonError(c, 404, `package '${name}' not found`);
  const versions = (await getVersionStrings(c.env, name)).reverse(); // newest first
  return c.json({
    name: pkg.name,
    description: pkg.description,
    namespace: pkg.namespace,
    keywords: pkg.keywords,
    latest_version: pkg.latest_version,
    versions,
  });
});
