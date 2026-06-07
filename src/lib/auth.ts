// AuthN/Z for publish (§15). Bearer tokens are stored hashed in
// `publish_tokens`; the raw token is shown once at mint time. mTLS is a
// production deployment concern (Cloudflare terminates the client cert and
// forwards it as a header) — stubbed here behind the same interface.
//
// Dev relaxation: when ALLOW_UNSIGNED=1 (local only), a missing/unknown
// token authenticates as the synthetic principal "dev-anonymous" so the
// seed/fixture flow works without minting a token. Production sets
// ALLOW_UNSIGNED=0 and this path is off.
import type { Env } from '../types';
import { sha256Hex } from './sha';

export interface AuthResult {
  ok: boolean;
  principal?: string;
  status?: number; // 401 / 403 when !ok
  message?: string;
}

function bearerToken(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

export async function tokenHash(token: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(token));
}

export async function authenticatePublish(
  env: Env,
  request: Request,
): Promise<AuthResult> {
  const devMode = env.ALLOW_UNSIGNED === '1';
  const token = bearerToken(request);

  if (!token) {
    if (devMode) return { ok: true, principal: 'dev-anonymous' };
    return { ok: false, status: 401, message: 'missing bearer token' };
  }

  const hash = await tokenHash(token);
  const row = await env.DB.prepare(
    'SELECT principal, expires_at FROM publish_tokens WHERE token_hash = ?',
  )
    .bind(hash)
    .first<{ principal: string; expires_at: string | null }>();

  if (!row) {
    if (devMode) return { ok: true, principal: 'dev-anonymous' };
    return { ok: false, status: 403, message: 'unknown token' };
  }
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    return { ok: false, status: 403, message: 'token expired' };
  }
  return { ok: true, principal: row.principal };
}
