// Plan 1.1.1 – 1.1.5. Spec §3.5, §3.6.
//
// The whole point of this file is a negative: an administrative verb must be
// unreachable with a publish token. §1.4.1 of the spec describes the deployed
// defect this prevents — a stolen publish token that can also register the key
// it signs with.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  authenticateAdmin,
  authenticatePublish,
  tokenHash,
} from '../../src/lib/auth';

const ADMIN_TOKEN = 'olla-admin-9f3c';
const PUBLISH_TOKEN = 'olla-publish-4a71';
const EXPIRED_ADMIN_TOKEN = 'olla-admin-expired-0001';

function request(token?: string): Request {
  return new Request('https://olla.cajeta.dev/v2/admin/org-keys/dev.cajeta', {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function insertToken(
  table: 'admin_tokens' | 'publish_tokens',
  token: string,
  principal: string,
  expiresAt: string | null,
) {
  await env.DB.prepare(
    `INSERT INTO ${table} (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      await tokenHash(token),
      principal,
      'publish',
      new Date().toISOString(),
      expiresAt,
    )
    .run();
}

// Seeded once: the workers pool shares D1 storage across the tests in a
// file, so a per-test insert of the same token collides on its primary key.
beforeAll(async () => {
  await insertToken('admin_tokens', ADMIN_TOKEN, 'owner:julian', null);
  await insertToken(
    'admin_tokens',
    EXPIRED_ADMIN_TOKEN,
    'owner:julian',
    new Date(Date.now() - 60_000).toISOString(),
  );
  await insertToken('publish_tokens', PUBLISH_TOKEN, 'dev.cajeta', null);
});

describe('authenticateAdmin', () => {
  it('accepts a token in admin_tokens (1.1.1)', async () => {
    const result = await authenticateAdmin(env, request(ADMIN_TOKEN));
    expect(result.ok).toBe(true);
    expect(result.principal).toBe('owner:julian');
  });

  it('refuses an unknown token with 403 (1.1.1)', async () => {
    const result = await authenticateAdmin(env, request('not-a-token'));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('refuses a missing token with 401 (1.1.1)', async () => {
    const result = await authenticateAdmin(env, request());
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('REFUSES a valid publish token (1.1.2)', async () => {
    const result = await authenticateAdmin(env, request(PUBLISH_TOKEN));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('refuses an expired admin token (1.1.4)', async () => {
    const result = await authenticateAdmin(env, request(EXPIRED_ADMIN_TOKEN));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  it('is not relaxed by ALLOW_UNSIGNED=1 (1.1.5)', async () => {
    const dev = { ...env, ALLOW_UNSIGNED: '1' };
    expect((await authenticateAdmin(dev, request())).status).toBe(401);
    expect((await authenticateAdmin(dev, request('not-a-token'))).status).toBe(
      403,
    );
  });
});

describe('authenticatePublish', () => {
  it('refuses an admin token (1.1.3)', async () => {
    const result = await authenticatePublish(env, request(ADMIN_TOKEN));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
  });

  // The converse of 1.1.3: the separation is only meaningful if the publish
  // path still works. A test that only asserts refusals passes when
  // authentication is broken outright.
  it('still accepts a publish token', async () => {
    const result = await authenticatePublish(env, request(PUBLISH_TOKEN));
    expect(result.ok).toBe(true);
    expect(result.principal).toBe('dev.cajeta');
  });
});
