// Plan 2.1.3 – 2.1.7, 2.2.4, 2.3.1. Spec §3.2 – §3.4, §3.10.
//
// Routes are exercised through the real Hono app with a real D1 behind it.
// The app is called directly rather than through SELF so each test can vary
// the trusted root — which the real-ceremony test at the bottom needs.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { admin } from '../../src/routes/admin';
import { tokenHash } from '../../src/lib/auth';
import {
  delegation,
  foreignKey,
  makeEnvelope,
  orgDocument,
  publicKeyPem,
  revocation,
} from '../helpers/documents';
import realRootPem from '../fixtures/olla-root.pub?raw';
import realDelegation from '../fixtures/repository-keys.json?raw';

const ADMIN = 'olla-admin-upload-tests';
const PUBLISH = 'olla-publish-upload-tests';

beforeAll(async () => {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO admin_tokens (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, 'owner:julian', 'admin', ?, NULL)`,
  )
    .bind(await tokenHash(ADMIN), now)
    .run();
  await env.DB.prepare(
    `INSERT INTO publish_tokens (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, 'dev.cajeta', 'publish', ?, NULL)`,
  )
    .bind(await tokenHash(PUBLISH), now)
    .run();
});

function post(path: string, body: string, token = ADMIN, headers = {}) {
  return new Request(`https://olla.cajeta.dev${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
}

function upload(path: string, body: string, over: Partial<typeof env> = {}) {
  return admin.fetch(post(path, body), { ...env, ...over });
}

describe('admin uploads', () => {
  it('stores an organization document signed by the root', async () => {
    const text = await makeEnvelope({ payload: orgDocument() });
    const res = await upload('/v2/admin/org-keys/dev.cajeta', text);
    expect(res.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT envelope, key_id FROM signed_documents WHERE kind = 'org-keys' AND subject = 'dev.cajeta'",
    ).first<{ envelope: string; key_id: string }>();
    expect(row!.envelope).toBe(text);
    expect(row!.key_id).toBe('test-root-1');
  });

  it('refuses an upload authenticated with a publish token (1.1.2, §3.6)', async () => {
    const text = await makeEnvelope({ payload: orgDocument() });
    const res = await admin.fetch(
      post('/v2/admin/org-keys/refused.example', text, PUBLISH),
      env,
    );
    expect(res.status).toBe(403);
    expect(await stored('org-keys', 'refused.example')).toBeNull();
  });

  it('REFUSES an envelope the root did not sign, and stores nothing (2.1.2)', async () => {
    const other = await foreignKey();
    const text = await makeEnvelope(
      { payload: orgDocument({ organization: 'unsigned.example' }) },
      other.privateKey,
    );
    const res = await upload('/v2/admin/org-keys/unsigned.example', text);
    expect(res.status).toBe(400);
    expect(await stored('org-keys', 'unsigned.example')).toBeNull();
  });

  it('refuses a delegation POSTed to the org-keys endpoint (2.1.3)', async () => {
    const text = await makeEnvelope({ payload: delegation() });
    const res = await upload('/v2/admin/org-keys/dev.cajeta', text);
    expect(res.status).toBe(400);
    expect((await res.json<{ error: string }>()).error).toMatch(/repository-keys/);
  });

  it('refuses an organization document POSTed to the delegation endpoint (2.1.4)', async () => {
    const text = await makeEnvelope({ payload: orgDocument() });
    const res = await upload('/v2/admin/repository-keys', text);
    expect(res.status).toBe(400);
  });

  it('refuses a document whose organization does not match the URL', async () => {
    const text = await makeEnvelope({
      payload: orgDocument({ organization: 'dev.cajeta' }),
    });
    const res = await upload('/v2/admin/org-keys/someone.else', text);
    expect(res.status).toBe(400);
  });

  it('refuses an already-expired document (2.1.6)', async () => {
    const text = await makeEnvelope({
      payload: orgDocument({
        organization: 'expired.example',
        'not-after': '2020-01-01T00:00:00Z',
      }),
    });
    const res = await upload('/v2/admin/org-keys/expired.example', text);
    expect(res.status).toBe(400);
    expect(await stored('org-keys', 'expired.example')).toBeNull();
  });

  // The pair IS the check: refusing everything would pass the first half.
  describe('replay (2.1.5)', () => {
    it('accepts a document when nothing is stored yet', async () => {
      const text = await makeEnvelope({
        payload: orgDocument({
          organization: 'replay.example',
          'issued-at': '2026-06-01T00:00:00Z',
        }),
      });
      expect((await upload('/v2/admin/org-keys/replay.example', text)).status).toBe(200);
    });

    it('refuses one older than what is stored', async () => {
      const older = await makeEnvelope({
        payload: orgDocument({
          organization: 'replay.example',
          'issued-at': '2026-01-01T00:00:00Z',
        }),
      });
      const res = await upload('/v2/admin/org-keys/replay.example', older);
      expect(res.status).toBe(409);

      const row = await stored('org-keys', 'replay.example');
      expect(row!.issued_at).toBe('2026-06-01T00:00:00Z');
    });

    it('accepts a newer one', async () => {
      const newer = await makeEnvelope({
        payload: orgDocument({
          organization: 'replay.example',
          'issued-at': '2026-12-01T00:00:00Z',
        }),
      });
      expect((await upload('/v2/admin/org-keys/replay.example', newer)).status).toBe(200);
      expect((await stored('org-keys', 'replay.example'))!.issued_at).toBe(
        '2026-12-01T00:00:00Z',
      );
    });
  });

  describe('revocation is verified against the delegation (2.1.7)', () => {
    let releaseKey: CryptoKeyPair;

    beforeAll(async () => {
      releaseKey = await foreignKey();
      const deleg = await makeEnvelope({
        payload: delegation({
          keys: [
            {
              id: 'release-1',
              algorithm: 'ed25519',
              'public-key': await publicKeyPem(releaseKey),
              'not-before': '2026-01-01T00:00:00Z',
              'not-after': '2099-01-01T00:00:00Z',
            },
          ],
        }),
      });
      expect((await upload('/v2/admin/repository-keys', deleg)).status).toBe(200);
    });

    it('accepts one signed by a delegated key', async () => {
      const text = await makeEnvelope({ payload: revocation() }, releaseKey.privateKey);
      expect((await upload('/v2/admin/revocations', text)).status).toBe(200);
    });

    it('REFUSES one signed by the root', async () => {
      const text = await makeEnvelope({
        payload: revocation({ 'issued-at': '2026-09-03T00:00:00Z' }),
      });
      const res = await upload('/v2/admin/revocations', text);
      expect(res.status).toBe(400);
    });
  });

  it('records an audit row for every accepted upload (2.2.4)', async () => {
    const text = await makeEnvelope({
      payload: orgDocument({ organization: 'audited.example' }),
    });
    await upload('/v2/admin/org-keys/audited.example', text);

    const row = await env.DB.prepare(
      "SELECT actor, action, target, after_state FROM audit_log WHERE target = 'audited.example'",
    ).first<{ actor: string; action: string; target: string; after_state: string }>();
    expect(row!.actor).toBe('owner:julian');
    expect(row!.action).toBe('org-keys.store');
    expect(row!.after_state).not.toBeNull();
  });

  it('records no audit row for a refused upload', async () => {
    const other = await foreignKey();
    const text = await makeEnvelope(
      { payload: orgDocument({ organization: 'unaudited.example' }) },
      other.privateKey,
    );
    await upload('/v2/admin/org-keys/unaudited.example', text);

    const row = await env.DB.prepare(
      "SELECT seq FROM audit_log WHERE target = 'unaudited.example'",
    ).first();
    expect(row).toBeNull();
  });
});

// 2.3.1 — the real ceremony output, signed offline by the production root.
// Not a fixture we generated: if the toolkit and this verifier ever disagree
// about framing, base64 or what the signature covers, this is where it shows.
describe('the operator toolkit (2.3.1)', () => {
  it('uploads and stores the real signed delegation', async () => {
    // A delegation is a singleton — one row, keyed (repository-keys, ''). The
    // revocation tests above stored a synthetic one expiring in 2099, and the
    // real ceremony output expires in 2027, so the replay check would refuse
    // it. That refusal is correct (a delegation is ordered by its not-after,
    // see VerifiedDocument.ordering); clear the row so this test measures what
    // it is about, which is whether the toolkit's bytes verify.
    await env.DB.prepare(
      "DELETE FROM signed_documents WHERE kind = 'repository-keys' AND subject = ''",
    ).run();

    const res = await upload('/v2/admin/repository-keys', realDelegation, {
      CAJETA_ROOT_KEY_PEM: realRootPem,
      CAJETA_ROOT_KEY_ID: 'olla-root-1',
    });
    expect(res.status).toBe(200);

    const row = await stored('repository-keys', '');
    expect(row!.envelope).toBe(realDelegation);
    expect(row!.key_id).toBe('olla-root-1');
  });
});

function stored(kind: string, subject: string) {
  return env.DB.prepare(
    'SELECT envelope, key_id, issued_at FROM signed_documents WHERE kind = ? AND subject = ?',
  )
    .bind(kind, subject)
    .first<{ envelope: string; key_id: string; issued_at: string }>();
}
