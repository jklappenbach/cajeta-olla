// Plan 6.1.1 – 6.1.2. Spec §6.1, §6.3, and the §1.4.1 finding they close.
//
// `POST /v2/keys` registered a signing key under PUBLISH authority, so the
// same credential that uploaded artifacts could register the key that signed
// them — one stolen token bought both. It is removed rather than deprecated:
// a deprecated endpoint that still answers is still a bypass, and a 403 is an
// endpoint saying "not you", which invites finding the credential that works.
//
// The table behind it is retired too. The endpoint being gone is worth little
// if a row in `trust_keys` still authorises anything, so the second test puts
// the table back and proves nothing reads it.
import { SELF, env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrg, mintPublishToken, publishAs, type Org } from '../helpers/publishing';
import { tokenHash } from '../../src/lib/auth';
import { fingerprintOfPublicKeyPem } from '../../src/lib/signature';
import { publicKeyPem } from '../helpers/documents';

const ADMIN = 'olla-admin-legacy-tests';
const PUBLISH_ONLY = 'olla-publish-legacy-tests';
let org: Org;

beforeAll(async () => {
  org = await makeOrg({ organization: 'dev.legacy', keyId: 'legacy-org-1' });
  await mintPublishToken('dev.publisher', PUBLISH_ONLY);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO admin_tokens
       (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, 'owner:tests', 'admin', ?, NULL)`,
  )
    .bind(await tokenHash(ADMIN), new Date().toISOString())
    .run();
});

function post(path: string, token: string | null, body: unknown) {
  return SELF.fetch(`https://olla.cajeta.dev${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe('POST /v2/keys is gone (6.1.1)', () => {
  const registration = {
    'key-id': 'smuggled-1',
    'public-key': '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
  };

  // 404, not 403. The distinction is the whole point of removing rather than
  // deprecating: 403 says the endpoint is there and this credential is wrong,
  // which is an invitation to go find the one that is not.
  it('answers 404 to a publish token', async () => {
    const res = await post('/v2/keys', PUBLISH_ONLY, registration);
    expect(res.status).toBe(404);
  });

  it('answers 404 to an owner token too — no credential reaches it', async () => {
    expect((await post('/v2/keys', ADMIN, registration)).status).toBe(404);
  });

  it('answers 404 unauthenticated', async () => {
    expect((await post('/v2/keys', null, registration)).status).toBe(404);
  });
});

describe('the legacy trust store authorises nothing (6.1.2)', () => {
  it('no longer exists in the schema', async () => {
    const row = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trust_keys'",
    ).first<{ name: string }>();
    expect(row).toBeNull();
  });

  // The stronger form: put the table back, exactly as a leftover deployment
  // would have it, with a key whose signature over these bytes is genuinely
  // good. Under the old rule this published. It must not now.
  it('is not read even when the table and a valid key are restored', async () => {
    const stray = await makeOrg({
      organization: 'dev.stray',
      document: false, // its key lives ONLY in the legacy table
      keyId: 'stray-1',
    });

    await env.DB.prepare(
      `CREATE TABLE IF NOT EXISTS trust_keys (
         key_id TEXT PRIMARY KEY, public_key TEXT NOT NULL, principal TEXT,
         fingerprint TEXT, created_at TEXT NOT NULL)`,
    ).run();
    await env.DB.prepare(
      `INSERT OR REPLACE INTO trust_keys
         (key_id, public_key, principal, fingerprint, created_at)
       VALUES ('stray-1', ?, 'dev.legacy', ?, ?)`,
    )
      .bind(
        await publicKeyPem(stray.pair),
        await fingerprintOfPublicKeyPem(await publicKeyPem(stray.pair)),
        new Date().toISOString(),
      )
      .run();

    // Signed by a key the registry knows, for an organization that has a
    // current document. Only one thing is wrong: the key is not IN that
    // document. That is exactly the §1.4.1 shape.
    const res = await publishAs(org, 'dev.legacy.thing', '1.0.0', {
      signWith: stray.pair,
      keyId: 'stray-1',
    });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).toContain(
      'not in the signed key document',
    );

    await env.DB.prepare('DROP TABLE trust_keys').run();
  });

  it('still publishes with a key that IS in the document', async () => {
    expect((await publishAs(org, 'dev.legacy.thing', '1.0.0')).status).toBe(201);
  });
});

// §4.4 — the proofs survive, as owner-facing evidence gathered once at
// issuance. What changed is the authority: a publish token used to be enough.
describe('namespace proofs moved to owner authority (6.2.1)', () => {
  const proof = { domain: 'acme.com', 'public-key': 'not-a-pem' };

  it('refuses a publish token', async () => {
    const res = await post('/v2/namespaces/verify', PUBLISH_ONLY, proof);
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated caller', async () => {
    expect((await post('/v2/namespaces/verify', null, proof)).status).toBe(401);
  });

  // The not-fire case. An owner token gets past authentication and the request
  // fails on its own merits — a malformed PEM, decided before any lookup. A
  // suite that only asserts refusals cannot tell this from an endpoint that
  // refuses everyone.
  it('lets an owner token through to the request itself', async () => {
    const res = await post('/v2/namespaces/verify', ADMIN, proof);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain('SubjectPublicKeyInfo');
  });
});
