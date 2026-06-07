// GET /v2/transparency-log/:sha (§15). Returns the append-on-publish log
// entry for an artifact digest. :sha is bare hex.
import { Hono } from 'hono';
import type { Env } from '../types';
import { getTransparency } from '../lib/catalog';
import { isHex64, toCanonical } from '../lib/sha';
import { jsonError } from '../lib/http';

export const transparency = new Hono<{ Bindings: Env }>();

transparency.get('/v2/transparency-log/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isHex64(sha)) return jsonError(c, 400, 'malformed sha256 (want 64 hex chars)');
  const entry = await getTransparency(c.env, sha);
  if (!entry) return jsonError(c, 404, `no transparency-log entry for ${sha}`);
  return c.json({
    sha256: toCanonical(sha),
    'signed-at': entry.signed_at,
    'log-entry-signature': entry.log_entry_signature,
    'log-entry-key-id': entry.log_entry_key_id,
  });
});
