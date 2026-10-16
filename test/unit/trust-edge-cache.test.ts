// olla-publisher-trust plan 8.1.1 – 8.1.4. Spec §2.10: the origin is read per colo per TTL.
import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { trust } from '../../src/routes/trust';
import { admin } from '../../src/routes/admin';
import { tokenHash } from '../../src/lib/auth';
import { makeEnvelope, orgDocument } from '../helpers/documents';

const ADMIN = 'olla-admin-edge-cache-tests';

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await trust.fetch(new Request(`https://olla.cajeta.dev${path}`), env, ctx);
  const body = await res.text();
  await waitOnExecutionContext(ctx);
  return { status: res.status, body };
}

async function put(kind: string, subject: string, envelope: string) {
  await env.DB.prepare(
    `INSERT INTO signed_documents (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
     VALUES (?, ?, ?, '2026-09-01T00:00:00Z', '2099-01-01T00:00:00Z', 'test-root-1', ?)
     ON CONFLICT (kind, subject) DO UPDATE SET envelope = excluded.envelope`,
  )
    .bind(kind, subject, envelope, new Date().toISOString())
    .run();
}

async function upload(org: string, envelope: string) {
  const ctx = createExecutionContext();
  const res = await admin.fetch(
    new Request(`https://olla.cajeta.dev/v2/admin/org-keys/${org}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}` },
      body: envelope,
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await env.DB.prepare(
    `INSERT INTO admin_tokens (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, 'owner:julian', 'admin', ?, NULL)`,
  )
    .bind(await tokenHash(ADMIN), new Date().toISOString())
    .run();
});

describe('the edge cache answers repeated trust-document reads', () => {
  it('8.1.1 a second read of an organization document does not reach D1', async () => {
    await put('org-keys', 'cache-a.example', '{"first":1}');
    expect((await get('/v2/org-keys/cache-a.example')).body).toBe('{"first":1}');
    await put('org-keys', 'cache-a.example', '{"second":2}');
    expect((await get('/v2/org-keys/cache-a.example')).body).toBe('{"first":1}');
  });

  it('8.1.2 an admin upload evicts the cached organization document', async () => {
    const org = 'cache-b.example';
    await upload(org, await makeEnvelope({ payload: orgDocument({ organization: org, namespaces: [org] }) }));
    const before = (await get(`/v2/org-keys/${org}`)).body;
    const newer = await makeEnvelope({
      payload: orgDocument({ organization: org, namespaces: [org], 'issued-at': '2026-10-01T00:00:00Z' }),
    });
    expect((await upload(org, newer)).status).toBe(200);
    const after = (await get(`/v2/org-keys/${org}`)).body;
    expect(after).not.toBe(before);
    expect(after).toBe(newer);
  });

  it('8.1.3 a revocation is never served from the cache', async () => {
    await put('revocations', '', '{"rev":1}');
    expect((await get('/v2/revocations')).body).toBe('{"rev":1}');
    await put('revocations', '', '{"rev":2}');
    expect((await get('/v2/revocations')).body).toBe('{"rev":2}');
  });

  it('8.1.4 an absence is never served from the cache', async () => {
    expect((await get('/v2/org-keys/cache-c.example')).status).toBe(404);
    await put('org-keys', 'cache-c.example', '{"late":1}');
    expect((await get('/v2/org-keys/cache-c.example')).body).toBe('{"late":1}');
  });
});
