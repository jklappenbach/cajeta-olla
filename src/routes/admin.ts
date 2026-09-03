// Administrative uploads (publisher-trust §3).
//   POST /v2/admin/org-keys/<org>   — an organization's signed key document
//   POST /v2/admin/repository-keys  — the repository delegation
//   POST /v2/admin/revocations      — the current revocation statement
//
// Olla NEVER signs these. The operator signs offline with the root, which this
// deployment does not hold, and these endpoints accept the finished envelope
// (§3.1). An admin credential that could produce a root signature would forge
// any organization's document — the collapse the whole design exists to bound.
//
// Every one requires OWNER authority (§3.5). A publish token is simply not in
// admin_tokens, so it is refused here as an unknown token.
import { Hono } from 'hono';
import type { Env } from '../types';
import { authenticateAdmin } from '../lib/auth';
import { auditStatement } from '../lib/audit';
import {
  delegatedKeys,
  rootKeys,
  verifyEnvelope,
  type DocumentKind,
  type VerifiedDocument,
} from '../lib/envelope';
import { jsonError } from '../lib/http';

export const admin = new Hono<{ Bindings: Env }>();

const ENDPOINT: Record<DocumentKind, string> = {
  'org-keys': 'POST /v2/admin/org-keys/<org>',
  'repository-keys': 'POST /v2/admin/repository-keys',
  revocations: 'POST /v2/admin/revocations',
};

async function store(
  c: { env: Env; req: { raw: Request; text(): Promise<string> } },
  expected: DocumentKind,
  subject: string,
) {
  const auth = await authenticateAdmin(c.env, c.req.raw);
  if (!auth.ok) {
    return jsonError(c as never, auth.status ?? 401, auth.message ?? 'unauthorized');
  }

  const envelope = await c.req.text();

  // A revocation is verified against the DELEGATION's keys, never the root:
  // its short lifetime is only sustainable because an online key produces it,
  // and a root signature here would be exactly the long-lived statement the
  // design forbids. Building the candidate set from the delegation makes that
  // structural rather than a check someone can forget.
  const candidates =
    expected === 'revocations' ? await delegatedKeys(c.env) : rootKeys(c.env);
  if (candidates.length === 0) {
    return jsonError(
      c as never,
      expected === 'revocations' ? 400 : 500,
      expected === 'revocations'
        ? 'no repository delegation is stored, so no key may sign a revocation'
        : 'no trusted root is configured (CAJETA_ROOT_KEY_PEM)',
    );
  }

  let doc: VerifiedDocument;
  try {
    doc = await verifyEnvelope(envelope, candidates);
  } catch (e) {
    return jsonError(c as never, 400, (e as Error).message);
  }

  // The type discriminator inside the signature decides, never the URL (§3.3).
  if (doc.kind !== expected) {
    return jsonError(
      c as never,
      400,
      `this is a ${doc.kind} document; send it to ${ENDPOINT[doc.kind]}`,
    );
  }
  if (doc.kind === 'org-keys' && doc.subject !== subject) {
    return jsonError(
      c as never,
      400,
      `document speaks for '${doc.subject}', not '${subject}'`,
    );
  }

  // Expired at upload, not merely at serve time. Storing one would mean
  // serving a document that can never be accepted.
  if (Date.parse(doc.notAfter) <= Date.now()) {
    return jsonError(c as never, 400, `document expired at ${doc.notAfter}`);
  }

  const target = doc.kind === 'org-keys' ? subject : doc.kind;
  const existing = await c.env.DB.prepare(
    'SELECT envelope, key_id, issued_at FROM signed_documents WHERE kind = ? AND subject = ?',
  )
    .bind(doc.kind, subject)
    .first<{ envelope: string; key_id: string; issued_at: string }>();

  // Replay (§3.4): accepting an older document reinstates keys the
  // organization has already removed, which is how a revocation gets undone.
  if (existing && doc.ordering <= existing.issued_at) {
    return jsonError(
      c as never,
      409,
      `stored document is newer (${existing.issued_at}); refusing ${doc.ordering}`,
    );
  }

  // One transaction. A document stored with its audit write failed is an
  // unrecorded mutation, which is the case §3.10 exists for — and the reason
  // this is D1 rather than KV.
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO signed_documents
         (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind, subject) DO UPDATE SET
         envelope = excluded.envelope, issued_at = excluded.issued_at,
         not_after = excluded.not_after, key_id = excluded.key_id,
         stored_at = excluded.stored_at`,
    ).bind(
      doc.kind,
      subject,
      doc.envelope,
      doc.ordering,
      doc.notAfter,
      doc.keyId,
      new Date().toISOString(),
    ),
    auditStatement(c.env, {
      actor: auth.principal ?? 'unknown',
      action: `${doc.kind}.store`,
      target,
      before: existing
        ? { keyId: existing.key_id, issuedAt: existing.issued_at }
        : null,
      after: { keyId: doc.keyId, issuedAt: doc.ordering, notAfter: doc.notAfter },
    }),
  ]);

  return Response.json({
    stored: { kind: doc.kind, subject, keyId: doc.keyId, notAfter: doc.notAfter },
  });
}

admin.post('/v2/admin/org-keys/:org', (c) =>
  store(c, 'org-keys', c.req.param('org')),
);
admin.post('/v2/admin/repository-keys', (c) => store(c, 'repository-keys', ''));
admin.post('/v2/admin/revocations', (c) => store(c, 'revocations', ''));
