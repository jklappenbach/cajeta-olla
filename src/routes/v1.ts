// v1 paths (§11, §13). These mirror what the C++ HttpRepository client
// actually requests (authoritative over the prose spec):
//   GET /:pkg/versions.json                       -> { versions: [...] }
//   GET /:pkg/:version/:pkg-:version.cja          -> artifact bytes
//   GET /:pkg/:version/:pkg-:version.cja.sig      -> detached signature
//   GET /:pkg/:version/:pkg-:version.cja.sig.keyid-> signing key id
//   GET /:pkg/:version/manifest.json              -> sidecar manifest
//
// v1 responses do NOT carry the Cajeta-Capability-Version header.
import { Hono } from 'hono';
import type { Env } from '../types';
import { getVersionStrings, getVersion } from '../lib/catalog';
import { getBlob } from '../lib/storage';
import { toHex } from '../lib/sha';
import { jsonError } from '../lib/http';

export const v1 = new Hono<{ Bindings: Env }>();

// Version index. JSON shape the client parses: { "versions": ["1.0.0", ...] }.
v1.get('/:pkg/versions.json', async (c) => {
  const pkg = c.req.param('pkg');
  const versions = await getVersionStrings(c.env, pkg);
  if (versions.length === 0) {
    // 404 lets the client fall through to the next repository.
    return jsonError(c, 404, `package '${pkg}' not found`);
  }
  return c.json({ versions });
});

// Sidecar manifest (the dep's cajeta.json bytes; the client parses it to
// expand transitive deps).
v1.get('/:pkg/:version/manifest.json', async (c) => {
  const { pkg, version } = c.req.param();
  const row = await getVersion(c.env, pkg, version);
  if (!row) return jsonError(c, 404, `${pkg}@${version} not found`);
  return new Response(row.manifest_json, {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
});

// Artifact + detached signature + key id. One handler keyed off the suffix.
v1.get('/:pkg/:version/:filename', async (c) => {
  const { pkg, version, filename } = c.req.param();
  const base = `${pkg}-${version}.cja`;

  const row = await getVersion(c.env, pkg, version);
  if (!row) return jsonError(c, 404, `${pkg}@${version} not found`);

  if (filename === base) {
    const obj = await getBlob(c.env, row.sha256);
    if (!obj) return jsonError(c, 404, `blob for ${pkg}@${version} missing`);
    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(obj.size),
        ETag: `"${toHex(row.sha256)}"`,
        'Cache-Control': 'public, immutable, max-age=31536000',
      },
    });
  }

  if (filename === `${base}.sig`) {
    // The publisher's detached 64-byte Ed25519 signature (base64 in the DB),
    // served as raw bytes — exactly what the build tool wrote as `<archive>.sig`.
    const sigB64 = row.signature ?? '';
    if (!sigB64) return jsonError(c, 404, 'no signature on record');
    const bytes = Uint8Array.from(atob(sigB64), (ch) => ch.charCodeAt(0));
    return new Response(bytes, {
      status: 200,
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  if (filename === `${base}.sig.keyid`) {
    if (!row.key_id) return jsonError(c, 404, 'no key id on record');
    return new Response(row.key_id, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (filename === `${base}.attestation`) {
    if (!row.attestation) return jsonError(c, 404, 'no attestation on record');
    return new Response(row.attestation, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return jsonError(c, 404, `unknown artifact '${filename}'`);
});
