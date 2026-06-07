// Trust + namespace administration (§15).
//   POST /v2/keys                 — register a trusted Ed25519 public key.
//   POST /v2/namespaces/verify    — prove domain ownership (DNS-TXT / github).
// Both require publish auth (bearer token, or the dev bypass).
import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticatePublish } from '../lib/auth';
import { getTrustKey, addTrustKey } from '../lib/catalog';
import { fingerprintOfPublicKeyPem } from '../lib/signature';
import { verifyDnsTxt, verifyGithub, recordNamespace } from '../lib/namespace';
import { jsonError } from '../lib/http';

export const keys = new Hono<{ Bindings: Env }>();

keys.post('/v2/keys', async (c) => {
  const auth = await authenticatePublish(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');

  let body: { 'key-id'?: string; 'public-key'?: string; principal?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'expected JSON body');
  }
  const keyId = body['key-id'];
  const pem = body['public-key'];
  if (!keyId || !pem) {
    return jsonError(c, 400, "body must include 'key-id' and 'public-key' (PEM)");
  }
  let fingerprint: string;
  try {
    fingerprint = await fingerprintOfPublicKeyPem(pem);
  } catch {
    return jsonError(c, 400, 'public-key is not a valid PEM SubjectPublicKeyInfo');
  }
  await addTrustKey(c.env, {
    keyId,
    publicKey: pem,
    principal: body.principal ?? auth.principal ?? null,
    fingerprint,
    now: new Date().toISOString(),
  });
  return c.json({ registered: { 'key-id': keyId, fingerprint } }, 201);
});

keys.post('/v2/namespaces/verify', async (c) => {
  const auth = await authenticatePublish(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');

  let body: {
    domain?: string;
    'key-id'?: string;
    method?: string;
    owner?: string;
    repo?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'expected JSON body');
  }
  const { domain } = body;
  const keyId = body['key-id'];
  if (!domain || !keyId) {
    return jsonError(c, 400, "body must include 'domain' and 'key-id'");
  }
  const key = await getTrustKey(c.env, keyId);
  if (!key) return jsonError(c, 404, `unknown key-id '${keyId}'`);

  // The proof token is the key's fingerprint — the publisher places it in DNS
  // or the github proof file.
  const token = key.fingerprint ?? '';
  const method = body.method ?? 'dns';
  let ok = false;
  if (method === 'github') {
    if (!body.owner || !body.repo) {
      return jsonError(c, 400, "github method needs 'owner' and 'repo'");
    }
    ok = await verifyGithub(body.owner, body.repo, token);
  } else {
    ok = await verifyDnsTxt(domain, token);
  }
  if (!ok) {
    return jsonError(c, 422, `namespace proof for '${domain}' not found`, {
      hint:
        method === 'github'
          ? `add '${token}' to .github/cajeta-publish.txt in ${body.owner}/${body.repo}`
          : `publish a TXT record at _cajeta-publish.${domain} containing '${token}'`,
    });
  }
  await recordNamespace(
    c.env,
    domain,
    key.principal ?? auth.principal ?? keyId,
    method,
    token,
    new Date().toISOString(),
  );
  return c.json({ verified: { domain, method } });
});
