// POST /v2/publish (§10) — multipart form: archive (.cja), signature (.sig,
// optional), key-id, attestation (optional), metadata (JSON {name, version,
// sha256}). Pipeline: authn/z → integrity → immutability → store (R2 + D1) →
// index-on-publish (FTS triggers) → transparency-log append.
//
// Also POST /v2/retract {name, version, reason} — non-destructive yank.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticatePublish } from '../lib/auth';
import { getVersion, recordPublish, setRetracted } from '../lib/catalog';
import { putBlob, blobKey } from '../lib/storage';
import { sha256Canonical, toCanonical } from '../lib/sha';
import { parseManifestMeta } from '../lib/manifest';
import { jsonError } from '../lib/http';

export const publish = new Hono<{ Bindings: Env }>();

async function fileToBuffer(v: File | string | null): Promise<ArrayBuffer | null> {
  if (v && typeof v === 'object' && 'arrayBuffer' in v) return v.arrayBuffer();
  return null;
}
async function fieldToString(v: File | string | null): Promise<string | null> {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if ('text' in v) return v.text();
  return null;
}
function base64(bytes: ArrayBuffer): string {
  let s = '';
  const arr = new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
}

publish.post('/v2/publish', async (c) => {
  // 1. AuthN/Z.
  const auth = await authenticatePublish(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');

  let form: FormData;
  try {
    form = await c.req.raw.formData();
  } catch {
    return jsonError(c, 400, 'expected multipart/form-data');
  }

  const archive = await fileToBuffer(form.get('archive'));
  if (!archive) return jsonError(c, 400, "missing 'archive' field");

  const metadataStr = await fieldToString(form.get('metadata'));
  if (!metadataStr) return jsonError(c, 400, "missing 'metadata' field");
  let metadata: { name?: string; version?: string; sha256?: string };
  try {
    metadata = JSON.parse(metadataStr);
  } catch {
    return jsonError(c, 400, "'metadata' is not valid JSON");
  }
  const { name, version } = metadata;
  if (!name || !version) {
    return jsonError(c, 400, "metadata must include 'name' and 'version'");
  }

  const keyId = await fieldToString(form.get('key-id'));
  const sigBuf = await fileToBuffer(form.get('signature'));

  // 4. Signature requirement (verification against a trust store is §15;
  // here we enforce presence unless ALLOW_UNSIGNED).
  if (!sigBuf && c.env.ALLOW_UNSIGNED !== '1') {
    return jsonError(c, 400, 'unsigned publish rejected (no signature)');
  }

  // 3. Integrity — recompute the digest and check it against the claim.
  const computed = await sha256Canonical(archive);
  if (metadata.sha256 && toCanonical(metadata.sha256) !== computed) {
    return jsonError(c, 400, 'sha256 mismatch: archive does not match metadata.sha256', {
      hint: `computed ${computed}`,
    });
  }

  // 5. Immutability.
  const existing = await getVersion(c.env, name, version);
  if (existing) return jsonError(c, 409, `${name}@${version} already published`);

  // 6. Store bytes (R2) then catalog (D1). Bytes first so a D1 failure can't
  // leave a dangling pointer; a stray blob with no pointer is harmless.
  await putBlob(c.env, computed, archive);

  // Manifest metadata for catalog/search + a README if one rides along.
  const manifestJson = (await fieldToString(form.get('manifest'))) ?? '{}';
  const readme = (await fieldToString(form.get('readme'))) ?? '';
  const meta = parseManifestMeta(manifestJson);

  await recordPublish(c.env, {
    name,
    version,
    sha: computed,
    size: archive.byteLength,
    r2Key: blobKey(computed),
    manifestJson,
    readme,
    keywords: meta.keywords,
    description: meta.description,
    namespace: meta.namespace,
    keyId: keyId ?? null,
    signature: sigBuf ? base64(sigBuf) : null,
    now: new Date().toISOString(),
  });

  return c.json(
    { published: { name, version, sha256: computed }, principal: auth.principal },
    201,
  );
});

publish.post('/v2/retract', async (c) => {
  const auth = await authenticatePublish(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');
  let body: { name?: string; version?: string; reason?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'expected JSON body');
  }
  if (!body.name || !body.version) {
    return jsonError(c, 400, "body must include 'name' and 'version'");
  }
  const ok = await setRetracted(c.env, body.name, body.version, body.reason ?? '');
  if (!ok) return jsonError(c, 404, `${body.name}@${body.version} not found`);
  return c.json({ retracted: { name: body.name, version: body.version } });
});
