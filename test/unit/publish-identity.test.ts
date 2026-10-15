// olla-trusted-publishing plan 3.1.1 – 3.1.6. Spec §2.1, §3.3 – §3.5, §4.1,
// §5.1, §8.2.
//
// Trusted publishing decides WHO is uploading and nothing more: a bound
// identity walks through every publisher-trust refusal exactly as a token
// does. 3.1.4 is three of those refusals, one each, so a relaxation in the
// identity path cannot hide behind the happy path.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { publish } from '../../src/routes/publish';
import { capabilities } from '../../src/routes/capabilities';
import { putBinding } from '../../src/lib/publishers';
import { tokenHash } from '../../src/lib/auth';
import { makeOrg, signArchive, type Org } from '../helpers/publishing';
import {
  githubClaims,
  keySet,
  makeSigner,
  mintIdentityToken,
  type Signer,
} from '../helpers/identity';

let gh: Signer;
let org: Org;
let other: Org;

function e(over: Record<string, unknown> = {}) {
  return { ...env, OIDC_JWKS_JSON: keySet(gh), ...over } as typeof env;
}

async function publishWith(
  bearer: string,
  who: Org,
  name: string,
  version: string,
  opts: { signWith?: CryptoKeyPair; keyId?: string } = {},
) {
  const bytes = new TextEncoder().encode(`CAJETA-ARCHIVE\n${name}\n${version}\n`);
  const form = new FormData();
  form.set('archive', new Blob([bytes]), `${name}-${version}.cja`);
  form.set('metadata', JSON.stringify({ name, version }));
  form.set('manifest', JSON.stringify({ description: `${name} fixture` }));
  const sig = await signArchive(opts.signWith ?? who.pair, bytes);
  form.set('signature', new Blob([sig]), `${name}.sig`);
  form.set('key-id', opts.keyId ?? who.keyId);
  return publish.fetch(
    new Request('https://olla.cajeta.dev/v2/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${bearer}` },
      body: form,
    }),
    e(),
  );
}

beforeAll(async () => {
  gh = await makeSigner('gh-pub-1');
  org = await makeOrg({ organization: 'dev.trusted', namespaces: ['dev.trusted'] });
  other = await makeOrg({ organization: 'dev.elsewhere', namespaces: ['dev.elsewhere'] });
  await putBinding(
    env,
    { provider: 'github', repository: 'jklappenbach/trusted-lib', organization: 'dev.trusted' },
    'owner',
  );
  await putBinding(
    env,
    { provider: 'github', repository: 'jklappenbach/keyless-lib', organization: 'dev.keyless' },
    'owner',
  );
});

describe('publishing with a GitHub identity', () => {
  it('3.1.1 a bound identity publishes, and the audit row names repository, ref and workflow', async () => {
    const token = await mintIdentityToken(gh, githubClaims({ repository: 'jklappenbach/trusted-lib' }));
    const r = await publishWith(token, org, 'dev.trusted.lib', '1.0.0');
    expect(r.status, await r.clone().text()).toBe(201);
    const row = await env.DB.prepare(
      `SELECT actor, after_state FROM audit_log WHERE target = ? ORDER BY seq DESC LIMIT 1`,
    )
      .bind('dev.trusted.lib@1.0.0')
      .first<{ actor: string; after_state: string }>();
    expect(row).not.toBeNull();
    expect(row!.actor).toBe('dev.trusted');
    const after = JSON.parse(row!.after_state);
    expect(after.identity).toMatchObject({
      provider: 'github',
      repository: 'jklappenbach/trusted-lib',
      ref: 'refs/tags/v0.6.1',
    });
    expect(after.identity.workflowRef).toContain('release.yml');
  });

  it('3.1.2 an unbound repository is 403', async () => {
    const token = await mintIdentityToken(gh, githubClaims({ repository: 'jklappenbach/unbound-lib' }));
    const r = await publishWith(token, org, 'dev.trusted.unbound', '1.0.0');
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/not bound|no binding/i);
  });

  it('3.1.3 a branch ref under a tags-only binding is 403 naming ref and pattern', async () => {
    const token = await mintIdentityToken(
      gh,
      githubClaims({ repository: 'jklappenbach/trusted-lib', ref: 'refs/heads/main' }),
    );
    const r = await publishWith(token, org, 'dev.trusted.branch', '1.0.0');
    expect(r.status).toBe(403);
    const body = await r.text();
    expect(body).toContain('refs/heads/main');
    expect(body).toContain('refs/tags/*');
  });

  it('3.1.4 a bound identity still meets every publisher-trust refusal', async () => {
    // No key document for the bound organization.
    const keyless = await mintIdentityToken(gh, githubClaims({ repository: 'jklappenbach/keyless-lib' }));
    const r1 = await publishWith(keyless, org, 'dev.keyless.lib', '1.0.0');
    expect(r1.status).toBe(403);
    expect(await r1.text()).toMatch(/no signed key document/i);

    // A key from another organization's document.
    const bound = await mintIdentityToken(gh, githubClaims({ repository: 'jklappenbach/trusted-lib' }));
    const r2 = await publishWith(bound, org, 'dev.trusted.foreignkey', '1.0.0', {
      signWith: other.pair,
      keyId: other.keyId,
    });
    expect(r2.status).toBeGreaterThanOrEqual(400);
    expect(r2.status).toBeLessThan(500);
    expect(r2.status).not.toBe(201);

    // A name outside the organization's namespaces.
    const r3 = await publishWith(bound, org, 'dev.elsewhere.lib', '1.0.0');
    expect(r3.status).toBe(403);
    expect(await r3.text()).toMatch(/does not own/i);
  });

  it('3.1.5 the identity path never reads publish_tokens', async () => {
    // Store the JWT's own hash as if it were a minted publish token for a
    // different organization. If the identity path consulted the table, this
    // forged shortcut would publish as dev.elsewhere.
    const token = await mintIdentityToken(gh, githubClaims({ repository: 'jklappenbach/unbound-lib' }));
    await env.DB.prepare(
      `INSERT OR REPLACE INTO publish_tokens (token_hash, principal, scopes, created_at, expires_at)
       VALUES (?, 'dev.elsewhere', 'publish', ?, NULL)`,
    )
      .bind(await tokenHash(token), new Date().toISOString())
      .run();
    const r = await publishWith(token, other, 'dev.elsewhere.shortcut', '1.0.0');
    expect(r.status).toBe(403);
    expect(await r.text()).toMatch(/not bound|no binding/i);
  });

  it('3.1.6 capabilities advertise trusted publishing for github', async () => {
    const r = await capabilities.fetch(new Request('https://olla.cajeta.dev/.well-known/cajeta-capabilities.json'), env);
    expect(r.status).toBe(200);
    const doc = (await r.json()) as { capabilities: { 'trusted-publishing'?: string[] } };
    expect(doc.capabilities['trusted-publishing']).toEqual(['github']);
  });
});
