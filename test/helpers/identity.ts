// Fixtures for trusted publishing (olla-trusted-publishing §2, §8.1): a test
// RSA key standing in for GitHub's, its key set in the JWKS shape GitHub
// serves, and identity tokens minted with the claims a GitHub Actions job
// carries. Everything is WebCrypto so it runs inside the workers pool.
import { env } from 'cloudflare:test';
import { tokenHash } from '../../src/lib/auth';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const OLLA_AUDIENCE = 'olla.cajeta.dev';

export interface Signer {
  kid: string;
  pair: CryptoKeyPair;
  jwk: JsonWebKey & { kid: string; alg: string; use: string }; // public half, as GitHub publishes it
}

export async function makeSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return { kid, pair, jwk: Object.assign({}, jwk, { kid, alg: 'RS256', use: 'sig' }) };
}

/** The JWKS document for these signers, as `OIDC_JWKS_JSON` carries it. */
export function keySet(...signers: Signer[]): string {
  return JSON.stringify({ keys: signers.map((s) => s.jwk) });
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const enc = new TextEncoder();

/** The claims a GitHub Actions job's token carries, with sane defaults. */
export function githubClaims(over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const repository = (over.repository as string) ?? 'jklappenbach/cajeta-http';
  const ref = (over.ref as string) ?? 'refs/tags/v0.6.1';
  return {
    iss: GITHUB_ISSUER,
    aud: OLLA_AUDIENCE,
    sub: `repo:${repository}:ref:${ref}`,
    repository,
    repository_owner: repository.split('/')[0],
    repository_id: '123456',
    ref,
    ref_type: ref.startsWith('refs/tags/') ? 'tag' : 'branch',
    workflow_ref: `${repository}/.github/workflows/release.yml@${ref}`,
    job_workflow_ref: `jklappenbach/cajeta/.github/workflows/lib-release.yml@refs/heads/main`,
    event_name: 'push',
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    ...over,
  };
}

/** A signed identity token. `header` overrides let a test lie about `kid`. */
export async function mintIdentityToken(
  signer: Signer,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = {},
): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: signer.kid, ...header })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', signer.pair.privateKey, enc.encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(sig)}`;
}

/** An admin token row, for the owner-only binding verbs. */
export async function mintAdminToken(principal: string, token: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO admin_tokens (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, ?, 'owner', ?, NULL)`,
  )
    .bind(await tokenHash(token), principal, new Date().toISOString())
    .run();
}
