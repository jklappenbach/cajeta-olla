// POST /v2/publish (§10) — multipart form: archive (.cja), signature (.sig,
// optional), key-id, attestation (optional), metadata (JSON {name, version,
// sha256}). Pipeline: authn/z → integrity → immutability → store (R2 + D1) →
// index-on-publish (FTS triggers) → transparency-log append.
//
// Also POST /v2/retract {name, version, reason} — non-destructive yank.
import { Hono, type Context } from 'hono';
import type { Env } from '../types';
import { authenticatePublish } from '../lib/auth';
import { getVersion, recordPublish, setRetracted, getTrustKey } from '../lib/catalog';
import { putBlob, blobKey } from '../lib/storage';
import { sha256Canonical, toCanonical, toHex } from '../lib/sha';
import { parseManifestMeta } from '../lib/manifest';
import { verifyDetached, signLogEntry, base64 } from '../lib/signature';
import { verifyAttestation } from '../lib/attestation';
import { domainForPackage, isNamespaceVerified } from '../lib/namespace';
import { indexPackage, removeFromIndex } from '../lib/search-index';
import { jsonError } from '../lib/http';
import { signRelease } from '../lib/sign';
import { recordMutation } from '../lib/audit';

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
  const archiveBytes = new Uint8Array(archive);
  const dev = c.env.ALLOW_UNSIGNED === '1';

  // 2. Namespace ownership (§15) — gated by REQUIRE_NAMESPACE.
  if (c.env.REQUIRE_NAMESPACE === '1') {
    const domain = domainForPackage(name);
    if (!domain || !(await isNamespaceVerified(c.env, domain, auth.principal ?? ''))) {
      return jsonError(c, 403, `namespace '${domain ?? name}' not verified for publisher`);
    }
  }

  // 4. Signature — verify the detached Ed25519 sig over the raw archive bytes
  // against the trusted key named by `key-id`.
  let storedSigB64: string | null = null;
  if (sigBuf) {
    const sig = new Uint8Array(sigBuf);
    if (!keyId) {
      if (!dev) return jsonError(c, 400, 'signature present but no key-id');
    } else {
      const trust = await getTrustKey(c.env, keyId);
      if (trust) {
        const ok = await verifyDetached(trust.public_key, sig, archiveBytes);
        if (!ok) return jsonError(c, 400, `signature verification failed for key-id '${keyId}'`);
      } else if (!dev) {
        return jsonError(c, 403, `untrusted key-id '${keyId}' (not in the registry trust store)`);
      }
    }
    storedSigB64 = base64(sig);
  } else if (!dev) {
    return jsonError(c, 400, 'unsigned publish rejected (no signature)');
  }

  // 3. Integrity — recompute the digest and check it against the claim.
  const computed = await sha256Canonical(archive);
  if (metadata.sha256 && toCanonical(metadata.sha256) !== computed) {
    return jsonError(c, 400, 'sha256 mismatch: archive does not match metadata.sha256', {
      hint: `computed ${computed}`,
    });
  }

  // 4b. Attestation (§15) — when present, verify the in-toto/SLSA provenance
  // structurally and bind its subject digest to this archive.
  const attestationJson = await fieldToString(form.get('attestation'));
  if (attestationJson) {
    const r = verifyAttestation(attestationJson, toHex(computed));
    if (!r.ok) return jsonError(c, 400, `attestation verification failed: ${r.error}`);
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

  // Transparency-log entry signed by the registry's own log key (§15).
  const now = new Date().toISOString();
  const logSig = await signLogEntry(
    c.env.LOG_SIGNING_KEY_PEM,
    c.env.LOG_SIGNING_KEY_ID,
    computed,
    now,
  );

  // §4.5 — the organization is the AUTHENTICATED PRINCIPAL. Never the
  // archive's name: a name is a string the publisher chooses, and deriving
  // ownership from one is the defect this design exists to remove.
  const organization = auth.principal ?? '';
  const signedMetadata = await signRelease(c.env, {
    name,
    version,
    sha256: computed,
    organization,
  });

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
    signature: storedSigB64,
    attestation: attestationJson,
    logSignatureB64: logSig.signatureB64,
    logKeyId: logSig.keyId,
    signedMetadata,
    organization,
    now,
  });

  await recordMutation(c.env, {
    actor: organization,
    action: 'release.publish',
    target: `${name}@${version}`,
    before: null,
    after: { sha256: computed, organization, signed: signedMetadata !== null },
  });

  // 7. Index-on-publish (Algolia; D1 FTS is maintained by triggers).
  await indexPackage(c.env, {
    name,
    version,
    description: meta.description,
    keywords: meta.keywords,
  });

  return c.json(
    { published: { name, version, sha256: computed }, principal: auth.principal },
    201,
  );
});

// Retraction is ADVISORY: the version still resolves and still installs, so a
// lockfile already pinning it keeps working. What changes is the `retracted`
// flag INSIDE the signed payload, which means re-signing — a retraction
// carried only in the plain half is one a mirror clears invisibly (§2.8).
async function setRetraction(
  c: Context<{ Bindings: Env }>,
  retracted: boolean,
) {
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

  const row = await getVersion(c.env, body.name, body.version);
  if (!row) return jsonError(c, 404, `${body.name}@${body.version} not found`);

  const reason = body.reason ?? '';
  // The organization comes from what was recorded at publish, not from the
  // caller — a retraction must not be able to restate who published it.
  const organization = row.organization ?? auth.principal ?? '';
  const signedMetadata = await signRelease(c.env, {
    name: body.name,
    version: body.version,
    sha256: row.sha256,
    organization,
    ...(retracted ? { retracted: true, 'retracted-reason': reason } : { retracted: false }),
  });

  const ok = await setRetracted(
    c.env, body.name, body.version, reason, retracted, signedMetadata,
  );
  if (!ok) return jsonError(c, 404, `${body.name}@${body.version} not found`);

  await recordMutation(c.env, {
    actor: auth.principal ?? 'unknown',
    action: retracted ? 'release.retract' : 'release.unretract',
    target: `${body.name}@${body.version}`,
    before: { retracted: row.retracted === 1 },
    after: { retracted, reason: retracted ? reason : null },
  });

  if (retracted) {
    // Drop yanked packages from the Algolia index so they leave search.
    await removeFromIndex(c.env, body.name);
  }
  return c.json({
    [retracted ? 'retracted' : 'unretracted']: {
      name: body.name,
      version: body.version,
    },
  });
}

publish.post('/v2/retract', (c) => setRetraction(c, true));
publish.post('/v2/unretract', (c) => setRetraction(c, false));
