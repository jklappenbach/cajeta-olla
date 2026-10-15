// AuthN/Z (§15, and publisher-trust §3.5). Bearer tokens are stored hashed;
// the raw token is shown once at mint time. mTLS is a production deployment
// concern (Cloudflare terminates the client cert and forwards it as a header)
// — stubbed here behind the same interface.
//
// TWO credentials, in two tables. A publish token lives in `publish_tokens`
// and can publish; an owner token lives in `admin_tokens` and can change who
// is trusted. Neither table is consulted by the other's entry point, so
// "a publish token cannot reach an administrative verb" is a fact about
// storage rather than a convention someone can forget.
//
// Dev relaxation: when ALLOW_UNSIGNED=1 (local only), a missing/unknown
// token authenticates for PUBLISH as the synthetic principal "dev-anonymous"
// so the seed/fixture flow works without minting a token. Production sets
// ALLOW_UNSIGNED=0 and this path is off. It never applies to admin.
import type { Env } from '../types';
import { sha256Hex } from './sha';
import { looksLikeJwt, verifyGithubIdentity, type Identity } from './oidc';
import { findBinding, refMatches } from './publishers';

export interface AuthResult {
  ok: boolean;
  principal?: string;
  status?: number; // 401 / 403 / 503 when !ok
  message?: string;
  /** Set when a GitHub identity token authenticated (trusted publishing §2). */
  identity?: Identity;
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

type Lookup =
  | { kind: 'missing' }
  | { kind: 'unknown' }
  | { kind: 'expired' }
  | { kind: 'found'; principal: string };

// `table` is a closed union, never caller-supplied text.
async function lookupToken(
  env: Env,
  request: Request,
  table: 'publish_tokens' | 'admin_tokens',
): Promise<Lookup> {
  const token = bearerToken(request);
  if (!token) return { kind: 'missing' };

  const hash = await tokenHash(token);
  const row = await env.DB.prepare(
    `SELECT principal, expires_at FROM ${table} WHERE token_hash = ?`,
  )
    .bind(hash)
    .first<{ principal: string; expires_at: string | null }>();

  if (!row) return { kind: 'unknown' };
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { kind: 'expired' };
  }
  return { kind: 'found', principal: row.principal };
}

export async function authenticatePublish(
  env: Env,
  request: Request,
): Promise<AuthResult> {
  // Trusted publishing (§2.1): a bearer shaped like a JWT is an identity
  // token and never a publish token. This branch reads no token table.
  const bearer = bearerToken(request);
  if (bearer && looksLikeJwt(bearer)) return authenticateIdentity(env, bearer);

  const devMode = env.ALLOW_UNSIGNED === '1';
  const found = await lookupToken(env, request, 'publish_tokens');

  switch (found.kind) {
    case 'missing':
      if (devMode) return { ok: true, principal: 'dev-anonymous' };
      return { ok: false, status: 401, message: 'missing bearer token' };
    case 'unknown':
      if (devMode) return { ok: true, principal: 'dev-anonymous' };
      return { ok: false, status: 403, message: 'unknown token' };
    case 'expired':
      return { ok: false, status: 403, message: 'token expired' };
    case 'found':
      return { ok: true, principal: found.principal };
  }
}

/**
 * A GitHub Actions identity (olla-trusted-publishing §2, §3): verify the
 * token, then the owner's binding says which organization this repository
 * publishes as (§3.2) and which refs may (§3.4). No binding, no publish
 * (§3.3). The organization then meets every publisher-trust refusal as a
 * token publisher would (§3.5); nothing here relaxes them.
 */
async function authenticateIdentity(env: Env, bearer: string): Promise<AuthResult> {
  const verified = await verifyGithubIdentity(env, bearer, Date.now());
  if (!verified.ok) return { ok: false, status: verified.status, message: verified.message };
  const id = verified.identity;
  const binding = await findBinding(env, id.provider, id.repository);
  if (!binding) {
    return {
      ok: false,
      status: 403,
      message:
        `repository ${id.provider}:${id.repository} is not bound to any organization; ` +
        `the owner binds it with PUT /v2/admin/publishers/<org>`,
    };
  }
  if (!refMatches(binding.refPattern, id.ref)) {
    return {
      ok: false,
      status: 403,
      message:
        `ref '${id.ref}' of ${id.provider}:${id.repository} is outside the bound pattern ` +
        `'${binding.refPattern}'`,
    };
  }
  return { ok: true, principal: binding.organization, identity: id };
}

/**
 * Owner authority (§3.5). Reads `admin_tokens` and nothing else, so a valid
 * publish token is simply an unknown token here (§3.6).
 *
 * There is no dev relaxation, deliberately. ALLOW_UNSIGNED exists so local
 * fixtures can publish; letting it mint owner authority would put the whole
 * design behind an environment variable.
 */
export async function authenticateAdmin(
  env: Env,
  request: Request,
): Promise<AuthResult> {
  const found = await lookupToken(env, request, 'admin_tokens');

  switch (found.kind) {
    case 'missing':
      return { ok: false, status: 401, message: 'missing bearer token' };
    case 'unknown':
      return { ok: false, status: 403, message: 'not an administrative token' };
    case 'expired':
      return { ok: false, status: 403, message: 'token expired' };
    case 'found':
      return { ok: true, principal: found.principal };
  }
}
