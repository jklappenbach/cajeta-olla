// GET /v2/blob/:sha (§13). Content-addressed fetch; :sha is bare hex (the
// client strips the "sha256:" prefix). Streamed from R2 with a strong ETag
// (= the digest), immutable caching, conditional If-None-Match → 304, and
// HTTP Range support for resumable installs.
import { Hono } from 'hono';
import type { Env } from '../types';
import { getBlobRange, headBlob } from '../lib/storage';
import { isHex64 } from '../lib/sha';
import { jsonError } from '../lib/http';

export const blob = new Hono<{ Bindings: Env }>();

function parseRange(header: string | undefined): R2Range | undefined {
  if (!header) return undefined;
  const m = header.match(/^bytes=(\d*)-(\d*)$/);
  if (!m) return undefined;
  const startStr = m[1];
  const endStr = m[2];
  if (startStr === '' && endStr === '') return undefined;
  if (startStr === '') return { suffix: parseInt(endStr, 10) };
  const offset = parseInt(startStr, 10);
  if (endStr === '') return { offset };
  return { offset, length: parseInt(endStr, 10) - offset + 1 };
}

blob.get('/v2/blob/:sha', async (c) => {
  const sha = c.req.param('sha');
  if (!isHex64(sha)) return jsonError(c, 400, 'malformed sha256 (want 64 hex chars)');

  const etag = `"${sha}"`;
  if (c.req.header('If-None-Match') === etag) {
    return new Response(null, { status: 304, headers: { ETag: etag } });
  }

  const head = await headBlob(c.env, sha);
  if (!head) return jsonError(c, 404, `blob ${sha} not found`);

  const range = parseRange(c.req.header('Range'));
  const obj = await getBlobRange(c.env, sha, range);
  if (!obj) return jsonError(c, 404, `blob ${sha} not found`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/octet-stream',
    ETag: etag,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, immutable, max-age=31536000',
  };

  if (range && obj.range) {
    const r: any = obj.range;
    const start = r.offset ?? (r.suffix ? head.size - r.suffix : 0);
    const len = r.length ?? (r.suffix ?? head.size - start);
    const end = start + len - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${head.size}`;
    headers['Content-Length'] = String(len);
    return new Response(obj.body, { status: 206, headers });
  }

  headers['Content-Length'] = String(head.size);
  return new Response(obj.body, { status: 200, headers });
});
