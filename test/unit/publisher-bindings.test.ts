// olla-trusted-publishing plan 2.1.1 – 2.1.5. Spec §3.1, §3.6, §3.7, §3.8.
//
// A binding is what turns a verified GitHub identity into an organization, so
// who may create one is the same question as who may change trusted keys:
// the owner, and only the owner. 2.1.2 is the standing negative.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { admin } from '../../src/routes/admin';
import { mintPublishToken } from '../helpers/publishing';
import {
  githubClaims,
  keySet,
  makeSigner,
  mintAdminToken,
  mintIdentityToken,
} from '../helpers/identity';

const OWNER = 'olla-admin-bind-1';
const PUBLISHER = 'olla-publish-bind-1';

function call(method: string, org: string, body?: unknown, token: string | null = OWNER) {
  return admin.fetch(
    new Request(`https://olla.cajeta.dev/v2/admin/publishers/${org}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
}

async function auditRows(target: string) {
  const r = await env.DB.prepare(
    `SELECT action, before_state, after_state FROM audit_log WHERE target = ? ORDER BY seq`,
  )
    .bind(target)
    .all<{ action: string; before_state: string | null; after_state: string | null }>();
  return r.results;
}

beforeAll(async () => {
  await mintAdminToken('owner', OWNER);
  await mintPublishToken('dev.cajeta', PUBLISHER);
});

describe('publisher bindings', () => {
  it('2.1.1 the owner creates, lists and removes a binding, and each change is audited', async () => {
    const put = await call('PUT', 'dev.cajeta', {
      provider: 'github',
      repository: 'jklappenbach/cajeta-http',
      'ref-pattern': 'refs/tags/*',
    });
    expect(put.status).toBe(200);

    const list = await call('GET', 'dev.cajeta');
    expect(list.status).toBe(200);
    const bindings = (await list.json()) as { bindings: Array<Record<string, string>> };
    expect(bindings.bindings).toEqual([
      expect.objectContaining({
        provider: 'github',
        repository: 'jklappenbach/cajeta-http',
        organization: 'dev.cajeta',
        'ref-pattern': 'refs/tags/*',
      }),
    ]);

    const del = await call('DELETE', 'dev.cajeta', {
      provider: 'github',
      repository: 'jklappenbach/cajeta-http',
    });
    expect(del.status).toBe(200);
    expect(((await (await call('GET', 'dev.cajeta')).json()) as { bindings: unknown[] }).bindings).toEqual([]);

    const rows = await auditRows('github:jklappenbach/cajeta-http');
    expect(rows.map((r) => r.action)).toEqual(['publisher.bind', 'publisher.unbind']);
    expect(rows[0].before_state).toBeNull();
    expect(JSON.parse(rows[0].after_state!)).toMatchObject({ organization: 'dev.cajeta' });
    expect(JSON.parse(rows[1].before_state!)).toMatchObject({ organization: 'dev.cajeta' });
    expect(rows[1].after_state).toBeNull();
  });

  it('2.1.2 THE test: a publish token and an identity token are both refused by every verb', async () => {
    const gh = await makeSigner('gh-bind');
    const identity = await mintIdentityToken(gh, githubClaims());
    const body = { provider: 'github', repository: 'jklappenbach/cajeta-codec' };
    for (const token of [PUBLISHER, identity, null]) {
      for (const method of ['PUT', 'GET', 'DELETE']) {
        const r = await call(method, 'dev.cajeta', method === 'GET' ? undefined : body, token);
        expect(r.status, `${method} with ${token ? token.slice(0, 12) : 'no token'}`).toBeGreaterThanOrEqual(401);
        expect(r.status).toBeLessThanOrEqual(403);
      }
    }
    // Nothing was created by the refused calls.
    const list = await call('GET', 'dev.cajeta');
    expect(((await list.json()) as { bindings: unknown[] }).bindings).toEqual([]);
    expect(keySet(gh)).toContain('gh-bind');
  });

  it('2.1.3 a repository bound to another organization is refused with 409 naming the holder', async () => {
    expect((await call('PUT', 'dev.cajeta', { provider: 'github', repository: 'jklappenbach/cajeta-unit' })).status).toBe(200);
    const r = await call('PUT', 'org.other', { provider: 'github', repository: 'jklappenbach/cajeta-unit' });
    expect(r.status).toBe(409);
    expect(await r.text()).toContain('dev.cajeta');
    // Re-binding to the same organization replaces, not refuses.
    const again = await call('PUT', 'dev.cajeta', {
      provider: 'github',
      repository: 'jklappenbach/cajeta-unit',
      'ref-pattern': 'refs/tags/v*',
    });
    expect(again.status).toBe(200);
    await call('DELETE', 'dev.cajeta', { provider: 'github', repository: 'jklappenbach/cajeta-unit' });
  });

  it('2.1.4 repositories compare case-insensitively and are stored lower-case', async () => {
    expect((await call('PUT', 'dev.cajeta', { provider: 'github', repository: 'JKlappenbach/Cajeta-Logging' })).status).toBe(200);
    const list = (await (await call('GET', 'dev.cajeta')).json()) as { bindings: Array<Record<string, string>> };
    expect(list.bindings.map((b) => b.repository)).toContain('jklappenbach/cajeta-logging');
    const dup = await call('PUT', 'org.other', { provider: 'github', repository: 'jklappenbach/CAJETA-LOGGING' });
    expect(dup.status).toBe(409);
    await call('DELETE', 'dev.cajeta', { provider: 'github', repository: 'jklappenbach/cajeta-logging' });
  });

  it('2.1.5 a missing ref pattern defaults to tags only', async () => {
    expect((await call('PUT', 'dev.cajeta', { provider: 'github', repository: 'jklappenbach/cajeta-primavera' })).status).toBe(200);
    const list = (await (await call('GET', 'dev.cajeta')).json()) as { bindings: Array<Record<string, string>> };
    const b = list.bindings.find((x) => x.repository === 'jklappenbach/cajeta-primavera');
    expect(b?.['ref-pattern']).toBe('refs/tags/*');
    await call('DELETE', 'dev.cajeta', { provider: 'github', repository: 'jklappenbach/cajeta-primavera' });
  });
});
