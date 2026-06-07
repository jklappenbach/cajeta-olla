// GET /v2/resolve?name=foo&version=1.2.3 (§11). Returns metadata only (no
// bytes). The client passes either an exact version or a constraint; we
// return the matching version's digest + deps so the client can fetch the
// blob and expand transitives. Field names match the C++ client's parser:
// sha256, size, deps[{name,version}], capabilities[], published-at,
// retracted, retracted-reason.
import { Hono } from 'hono';
import type { Env } from '../types';
import { getVersionStrings, getVersion, getBlobRow } from '../lib/catalog';
import { pickVersion } from '../lib/semver';
import { parseManifestMeta } from '../lib/manifest';
import { jsonError } from '../lib/http';

export const resolve = new Hono<{ Bindings: Env }>();

resolve.get('/v2/resolve', async (c) => {
  const name = c.req.query('name');
  // The client sends `version`; accept `version-constraint` too (prose spec).
  const request =
    c.req.query('version') ?? c.req.query('version-constraint') ?? '*';
  if (!name) return jsonError(c, 400, "missing 'name' query parameter");

  const available = await getVersionStrings(c.env, name);
  if (available.length === 0) return jsonError(c, 404, `package '${name}' not found`);

  const chosen = pickVersion(available, request);
  if (!chosen) {
    return jsonError(
      c,
      404,
      `no version of '${name}' satisfies '${request}'`,
      { hint: `available: ${available.join(', ')}` },
    );
  }

  const row = await getVersion(c.env, name, chosen);
  if (!row) return jsonError(c, 404, `${name}@${chosen} not found`);

  const blob = await getBlobRow(c.env, row.sha256);
  const meta = parseManifestMeta(row.manifest_json);

  const body: Record<string, unknown> = {
    name,
    version: chosen,
    sha256: row.sha256,
    size: blob?.size ?? 0,
    deps: meta.dependencies,
    capabilities: [],
    'published-at': row.published_at,
    retracted: row.retracted === 1,
  };
  if (row.retracted === 1 && row.retracted_reason) {
    body['retracted-reason'] = row.retracted_reason;
  }
  return c.json(body);
});
