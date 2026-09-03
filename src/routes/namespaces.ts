// POST /v2/namespaces/verify — check a namespace-control proof.
//
// OWNER authority (publisher-trust §3.5). This is evidence gathering, not
// authorisation: a namespace enters an organization's signed key document at
// issuance, on evidence of control over the name (§4.4). Nothing on the
// publish path reads what this records — the publish path reads the signed
// document, and only that.
//
// `POST /v2/keys` used to live here. It registered a trusted signing key under
// PUBLISH authority, so the same credential that uploaded artifacts could
// register the key that signed them: one stolen token bought both (§1.4.1).
// It is removed rather than deprecated (§6.3) — while it exists, the refusal
// it undoes is one API call away from being satisfied by the party it
// constrains. A key becomes trusted by appearing in a root-signed organization
// document, uploaded through POST /v2/admin/org-keys/<org>.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticateAdmin } from '../lib/auth';
import { auditStatement } from '../lib/audit';
import { fingerprintOfPublicKeyPem } from '../lib/signature';
import { verifyDnsTxt, verifyGithub, recordNamespace } from '../lib/namespace';
import { jsonError } from '../lib/http';

export const namespaces = new Hono<{ Bindings: Env }>();

namespaces.post('/v2/namespaces/verify', async (c) => {
  const auth = await authenticateAdmin(c.env, c.req.raw);
  if (!auth.ok) return jsonError(c, auth.status ?? 401, auth.message ?? 'unauthorized');

  let body: {
    domain?: string;
    'public-key'?: string;
    method?: string;
    owner?: string;
    repo?: string;
    organization?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'expected JSON body');
  }
  const { domain } = body;
  const pem = body['public-key'];
  if (!domain || !pem) {
    return jsonError(c, 400, "body must include 'domain' and 'public-key'");
  }

  // The proof token is the fingerprint of the key the owner is about to sign
  // into the document. It is computed from the PEM in the request rather than
  // looked up: there is no registry of keys to look one up in any more, which
  // is the point.
  let token: string;
  try {
    token = await fingerprintOfPublicKeyPem(pem);
  } catch {
    return jsonError(c, 400, 'public-key is not a valid PEM SubjectPublicKeyInfo');
  }

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

  const now = new Date().toISOString();
  const organization = body.organization ?? auth.principal ?? domain;
  await recordNamespace(c.env, domain, organization, method, token, now);
  await c.env.DB.batch([
    auditStatement(c.env, {
      actor: auth.principal ?? 'unknown',
      action: 'namespace.evidence',
      target: domain,
      before: null,
      after: { method, organization, fingerprint: token },
    }),
  ]);

  return c.json({
    verified: { domain, method, organization, fingerprint: token },
    note:
      'evidence only — the namespace takes effect when it appears in a ' +
      'root-signed organization key document',
  });
});
