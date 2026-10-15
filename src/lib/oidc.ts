// Trusted publishing (olla-trusted-publishing §2): verify a GitHub Actions
// OpenID Connect identity token. A token that passes names the repository,
// ref and workflow the job ran for, signed by GitHub; the binding in
// `publishers.ts` then says which organization that repository may publish
// as. Nothing here reads `publish_tokens`, and nothing in the token path
// ever will: the two credentials have different shapes (§2.1).
//
// RS256 is the only algorithm GitHub signs with (its discovery document,
// read 2026-10-15), so it is the only one accepted. WebCrypto does the
// verification; there is no JWT dependency.
import type { Env } from '../types';

export const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
export const GITHUB_JWKS_URL = `${GITHUB_ISSUER}/.well-known/jwks`;
export const DEFAULT_AUDIENCE = 'olla.cajeta.dev';
/** Clock allowance on `exp` and `nbf` (§2.2.4). */
const SKEW_SECONDS = 60;
/** How long a fetched key set serves before it is refreshed (§2.4). */
const KEY_SET_LIFETIME_MS = 60 * 60 * 1000;

export interface Identity {
  provider: 'github';
  repository: string; // lower-cased owner/name
  repositoryOwner: string;
  ref: string;
  refType: string;
  workflowRef: string;
  jobWorkflowRef: string;
  subject: string;
}

export type IdentityResult =
  | { ok: true; identity: Identity }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Three base64url segments whose first decodes to a JSON header naming an
 * `alg` (§2.1). The shape test alone is not enough: a publish token for a
 * dotted organization (`olla-publish-uk.co.acme`) is also three runs between
 * dots, and must stay a publish token.
 */
export function looksLikeJwt(bearer: string): boolean {
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer)) return false;
  try {
    const header = decodeJson(bearer.split('.')[0]);
    return typeof header === 'object' && header !== null && typeof header.alg === 'string';
  } catch {
    return false;
  }
}

interface Jwk extends JsonWebKey {
  kid?: string;
  alg?: string;
}

/** Fetch the key set document as text; injectable for tests and for §1.1.4. */
export type KeySetFetch = () => Promise<string>;

interface CachedKeySet {
  keys: Jwk[];
  fetchedAt: number;
}
let cache: CachedKeySet | null = null;

/** Tests reset the in-isolate cache between cases. */
export function resetKeySetCache(): void {
  cache = null;
}

function parseKeySet(text: string): Jwk[] {
  const doc = JSON.parse(text) as { keys?: Jwk[] };
  if (!doc || !Array.isArray(doc.keys)) throw new Error('key set has no keys');
  return doc.keys;
}

async function defaultFetch(env: Env): Promise<string> {
  // §2.5: a supplied key set is for tests; production never sets it.
  if (env.OIDC_JWKS_JSON) return env.OIDC_JWKS_JSON;
  const res = await fetch(env.OIDC_JWKS_URL ?? GITHUB_JWKS_URL);
  if (!res.ok) throw new Error(`key set fetch returned ${res.status}`);
  return res.text();
}

/**
 * The key set, from cache when fresh. `force` refetches regardless, which is
 * how an unknown `kid` gets exactly one more look (§2.4). A fetch failure
 * throws and leaves the cache as it was: a failure is never cached.
 */
async function keySet(now: number, fetchKeys: KeySetFetch, force: boolean): Promise<Jwk[]> {
  if (!force && cache && now - cache.fetchedAt < KEY_SET_LIFETIME_MS) return cache.keys;
  const keys = parseKeySet(await fetchKeys());
  cache = { keys, fetchedAt: now };
  return keys;
}

function b64urlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeJson(segment: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(segment))) as Record<string, unknown>;
}

function refuse(message: string): IdentityResult {
  return { ok: false, status: 401, message };
}

/**
 * Verify `token` as a GitHub Actions identity token for this registry.
 * `now` is epoch millis; `fetchKeys` defaults to GitHub's key set (or the
 * test binding).
 */
export async function verifyGithubIdentity(
  env: Env,
  token: string,
  now: number,
  fetchKeys: KeySetFetch = () => defaultFetch(env),
): Promise<IdentityResult> {
  if (!looksLikeJwt(token)) return refuse('bearer is not an identity token');
  const [h, p, s] = token.split('.');
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = decodeJson(h);
    claims = decodeJson(p);
  } catch {
    return refuse('identity token is not valid JSON');
  }
  if (header.alg !== 'RS256') return refuse(`identity token algorithm '${String(header.alg)}' is not RS256`);
  const kid = typeof header.kid === 'string' ? header.kid : '';
  if (!kid) return refuse('identity token names no key id');

  // Keys: the cached set, then one refetch for a kid it lacks (§2.4). A fetch
  // that fails is a 503, never a 401 (§2.4).
  let jwk: Jwk | undefined;
  try {
    jwk = (await keySet(now, fetchKeys, false)).find((k) => k.kid === kid);
    if (!jwk) jwk = (await keySet(now, fetchKeys, true)).find((k) => k.kid === kid);
  } catch (e) {
    return { ok: false, status: 503, message: `identity key set unavailable: ${(e as Error).message}` };
  }
  if (!jwk) return refuse(`identity token signature key '${kid}' is not in the issuer's key set`);
  if (jwk.kty !== 'RSA') return refuse(`identity token key '${kid}' is not an RSA key`);

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
  } catch {
    return refuse(`identity token key '${kid}' could not be imported`);
  }
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlDecode(s),
    new TextEncoder().encode(`${h}.${p}`),
  );
  if (!valid) return refuse('identity token signature does not verify');

  // Claims (§2.2.2 – §2.2.4), each named in its refusal (§2.3).
  if (claims.iss !== GITHUB_ISSUER) return refuse(`identity token issuer '${String(claims.iss)}' is not GitHub Actions`);
  const audience = env.OIDC_AUDIENCE ?? DEFAULT_AUDIENCE;
  const aud = claims.aud;
  const audOk = Array.isArray(aud) ? aud.includes(audience) : aud === audience;
  if (!audOk) return refuse(`identity token audience is not '${audience}'`);
  const nowSec = Math.floor(now / 1000);
  if (typeof claims.exp !== 'number') return refuse('identity token has no expiry');
  if (claims.exp + SKEW_SECONDS < nowSec) return refuse('identity token has expired');
  if (typeof claims.nbf === 'number' && claims.nbf - SKEW_SECONDS > nowSec) {
    return refuse('identity token is not yet valid');
  }
  const repository = typeof claims.repository === 'string' ? claims.repository.toLowerCase() : '';
  if (!repository) return refuse('identity token names no repository');

  const str = (k: string) => (typeof claims[k] === 'string' ? (claims[k] as string) : '');
  return {
    ok: true,
    identity: {
      provider: 'github',
      repository,
      repositoryOwner: str('repository_owner').toLowerCase(),
      ref: str('ref'),
      refType: str('ref_type'),
      workflowRef: str('workflow_ref'),
      jobWorkflowRef: str('job_workflow_ref'),
      subject: str('sub'),
    },
  };
}
