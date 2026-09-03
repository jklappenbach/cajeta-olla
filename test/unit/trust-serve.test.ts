// Plan 3.1.1 – 3.1.9. Spec §2.1 – §2.5, §2.10, §2.11.
//
// Two pairs carry this file.
//
// 404-vs-503: a 404 means "this organization has no document", which a client
// reads as the legacy unsigned path. Returning it for a transient storage
// fault converts an outage into a fleet-wide verification bypass, silently.
//
// cached-vs-not: organization documents and the delegation cache for hours;
// a revocation must not cache at all, because a cached revocation is one an
// attacker gets for free. Testing only one of the two would pass with a
// single policy applied everywhere, which is the bug.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { trust } from '../../src/routes/trust';
import type { Env } from '../../src/types';

const HOUR = 3600;

function get(path: string, e: Env = env) {
  return trust.fetch(new Request(`https://olla.cajeta.dev${path}`), e);
}

async function store(
  kind: string,
  subject: string,
  envelope: string,
  notAfter: string,
) {
  await env.DB.prepare(
    `INSERT INTO signed_documents
       (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
     VALUES (?, ?, ?, '2026-09-01T00:00:00Z', ?, 'olla-root-1', ?)
     ON CONFLICT (kind, subject) DO UPDATE SET
       envelope = excluded.envelope, not_after = excluded.not_after`,
  )
    .bind(kind, subject, envelope, notAfter, new Date().toISOString())
    .run();
}

// Whitespace and key order a reserialiser would not reproduce: the point of
// §2.1 is that these bytes come back exactly as they were signed.
const ENVELOPE = `{
  "format" : 1,
    "root-key-id":"olla-root-1",
  "payload": "eyJoaSI6InRoZXJlIn0=",
  "signature": "c2ln"
}
`;

const FAR = '2099-01-01T00:00:00Z';

beforeAll(async () => {
  await store('org-keys', 'dev.cajeta', ENVELOPE, FAR);
  await store('repository-keys', '', ENVELOPE, FAR);
  await store('revocations', '', ENVELOPE, FAR);
});

describe('serving signed documents', () => {
  it('returns the organization envelope byte for byte (3.1.1)', async () => {
    const res = await get('/v2/org-keys/dev.cajeta');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(ENVELOPE);
  });

  it('returns 404 for an organization with no document (3.1.2)', async () => {
    const res = await get('/v2/org-keys/nobody.example');
    expect(res.status).toBe(404);
  });

  it('serves the delegation and the revocation the same way (3.1.4)', async () => {
    for (const path of ['/v2/repository-keys', '/v2/revocations']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(ENVELOPE);
    }
  });

  // THE distinction (3.1.3). A 404 is a statement about the organization; a
  // 503 is a statement about olla. Confusing them disables verification.
  it('returns 503 and never 404 when storage fails (3.1.3)', async () => {
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error('D1_ERROR: network');
        },
      },
    } as unknown as Env;

    for (const path of [
      '/v2/org-keys/dev.cajeta',
      '/v2/repository-keys',
      '/v2/revocations',
    ]) {
      const res = await get(path, broken);
      expect(res.status).toBe(503);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    }
  });

  it('never caches a 503 (3.1.9)', async () => {
    const broken = {
      ...env,
      DB: {
        prepare() {
          throw new Error('D1_ERROR: network');
        },
      },
    } as unknown as Env;
    const res = await get('/v2/org-keys/dev.cajeta', broken);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('does not serve an expired document (3.1.6)', async () => {
    await store('org-keys', 'expired.example', ENVELOPE, '2020-01-01T00:00:00Z');
    const res = await get('/v2/org-keys/expired.example');
    expect(res.status).toBe(404);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('cache policy', () => {
  it('caches an organization document (3.1.7)', async () => {
    const res = await get('/v2/org-keys/dev.cajeta');
    const cc = res.headers.get('Cache-Control')!;
    expect(cc).toMatch(/^public, max-age=\d+$/);
    expect(Number(cc.match(/max-age=(\d+)/)![1])).toBeGreaterThan(HOUR);
  });

  it('never lets the cache lifetime outlive not-after (3.1.7)', async () => {
    // Expires in about ten minutes: a document cached past its own expiry is
    // a stale document the client cannot refuse, because it never sees it.
    const soon = new Date(Date.now() + 10 * 60_000).toISOString().replace(/\.\d+Z$/, 'Z');
    await store('org-keys', 'soon.example', ENVELOPE, soon);

    const res = await get('/v2/org-keys/soon.example');
    expect(res.status).toBe(200);
    const maxAge = Number(
      res.headers.get('Cache-Control')!.match(/max-age=(\d+)/)![1],
    );
    expect(maxAge).toBeLessThanOrEqual(10 * 60);
    expect(maxAge).toBeGreaterThan(0);
  });

  it('caches the delegation (3.1.7)', async () => {
    const cc = (await get('/v2/repository-keys')).headers.get('Cache-Control')!;
    expect(cc).toMatch(/^public, max-age=\d+$/);
  });

  // THE cache test (3.1.8). Its pair is the two above: one document cached,
  // one not. A single policy applied everywhere passes half of this.
  it('serves a revocation NON-cacheable (3.1.8)', async () => {
    const res = await get('/v2/revocations');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('capabilities (3.1.5)', () => {
  it('advertises v2 and revocation=false', async () => {
    const { capabilityDoc } = await import('../../src/lib/capability');
    const doc = capabilityDoc(env);
    expect(doc.capabilities.v2).toBe(true);
    expect(doc.capabilities.revocation).toBe(false);
  });

  it('advertises revocation only when explicitly turned on', async () => {
    const { capabilityDoc } = await import('../../src/lib/capability');
    expect(
      capabilityDoc({ ...env, ADVERTISE_REVOCATION: '1' } as Env).capabilities
        .revocation,
    ).toBe(true);
  });
});
