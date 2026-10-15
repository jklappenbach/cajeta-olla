// olla-trusted-publishing plan 1.1.1 – 1.1.6. Spec §2.
//
// The verifier is the whole trust boundary of trusted publishing: a token it
// accepts names a repository that may then publish as an organization. Each
// §2.2 check gets a test that FIRES and the happy path proves none of them
// fires by accident.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { looksLikeJwt, verifyGithubIdentity, resetKeySetCache } from '../../src/lib/oidc';
import {
  GITHUB_ISSUER,
  githubClaims,
  keySet,
  makeSigner,
  mintIdentityToken,
  type Signer,
} from '../helpers/identity';

let github: Signer;
let stranger: Signer;
async function signers() {
  github ??= await makeSigner('gh-key-1');
  stranger ??= await makeSigner('somebody-else');
  return { github, stranger };
}

function withKeys(json: string, over: Record<string, unknown> = {}) {
  return { ...env, OIDC_JWKS_JSON: json, ...over } as typeof env;
}

describe('looksLikeJwt (§2.1)', () => {
  it('is three base64url segments and nothing else', () => {
    expect(looksLikeJwt('olla-publish-4a71')).toBe(false);
    expect(looksLikeJwt('a.b')).toBe(false);
    expect(looksLikeJwt('a.b.c.d')).toBe(false);
    expect(looksLikeJwt('a.b.c=')).toBe(false);
    // A publish token for a dotted organization is three runs between dots
    // too, and must stay a publish token: the header segment must be JSON.
    expect(looksLikeJwt('olla-publish-uk.co.acme')).toBe(false);
    expect(looksLikeJwt('aaa.bbb.ccc')).toBe(false);
    const header = btoa(JSON.stringify({ alg: 'RS256', kid: 'k' })).replace(/=+$/, '');
    expect(looksLikeJwt(`${header}.e30.c2ln`)).toBe(true);
  });
});

describe('verifyGithubIdentity', () => {
  it('1.1.1 accepts a token GitHub would mint and yields its identity', async () => {
    const { github } = await signers();
    resetKeySetCache();
    const token = await mintIdentityToken(github, githubClaims());
    const r = await verifyGithubIdentity(withKeys(keySet(github)), token, Date.now());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity.repository).toBe('jklappenbach/cajeta-http');
    expect(r.identity.ref).toBe('refs/tags/v0.6.1');
    expect(r.identity.workflowRef).toContain('release.yml');
  });

  it('1.1.2 refuses a token signed by another key, naming the signature', async () => {
    const { github, stranger } = await signers();
    resetKeySetCache();
    // Same kid as GitHub's key, wrong private key: the lookup succeeds and
    // the signature check is what refuses.
    const token = await mintIdentityToken(stranger, githubClaims(), { kid: github.kid });
    const r = await verifyGithubIdentity(withKeys(keySet(github)), token, Date.now());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.message).toMatch(/signature/i);
  });

  it('1.1.3 refuses wrong issuer, wrong audience, expired, and not-yet-valid, each by name', async () => {
    const { github } = await signers();
    resetKeySetCache();
    const e = withKeys(keySet(github));
    const now = Date.now();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ iss: 'https://evil.example' }, /issuer/i],
      [{ aud: 'some-other-service' }, /audience/i],
      [{ exp: Math.floor(now / 1000) - 120 }, /expired/i],
      [{ nbf: Math.floor(now / 1000) + 600 }, /not yet valid/i],
    ];
    for (const [over, why] of cases) {
      const token = await mintIdentityToken(github, githubClaims(over));
      const r = await verifyGithubIdentity(e, token, now);
      expect(r.ok, JSON.stringify(over)).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(401);
      expect(r.message).toMatch(why);
    }
    // Sixty seconds of clock allowance: a token that expired 30 s ago passes.
    const fresh = await mintIdentityToken(github, githubClaims({ exp: Math.floor(now / 1000) - 30 }));
    expect((await verifyGithubIdentity(e, fresh, now)).ok).toBe(true);
    expect(GITHUB_ISSUER).toBe('https://token.actions.githubusercontent.com');
  });

  it('1.1.4 refetches the key set once for an unknown kid', async () => {
    const { github } = await signers();
    const rotated = await makeSigner('gh-key-2');
    resetKeySetCache();
    let fetches = 0;
    const sets = [keySet(github), keySet(github, rotated)];
    const fetchKeys = async () => sets[Math.min(fetches++, sets.length - 1)];
    const token = await mintIdentityToken(rotated, githubClaims());
    const r = await verifyGithubIdentity({ ...env } as typeof env, token, Date.now(), fetchKeys);
    expect(r.ok).toBe(true);
    expect(fetches).toBe(2);
    // And a kid that is in neither set is refused after exactly one more fetch.
    const ghost = await makeSigner('gh-key-9');
    const t2 = await mintIdentityToken(ghost, githubClaims());
    const r2 = await verifyGithubIdentity({ ...env } as typeof env, t2, Date.now(), fetchKeys);
    expect(r2.ok).toBe(false);
    expect(fetches).toBe(3);
  });

  it('1.1.5 answers 503, not 401, when the key set cannot be fetched, and caches nothing', async () => {
    const { github } = await signers();
    resetKeySetCache();
    let fetches = 0;
    const failing = async () => {
      fetches++;
      throw new Error('upstream down');
    };
    const token = await mintIdentityToken(github, githubClaims());
    const r = await verifyGithubIdentity({ ...env } as typeof env, token, Date.now(), failing);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    // A second attempt fetches again: the failure was not cached.
    await verifyGithubIdentity({ ...env } as typeof env, token, Date.now(), failing);
    expect(fetches).toBe(2);
  });
});
