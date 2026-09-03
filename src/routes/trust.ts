// The three signed documents a client fetches (publisher-trust §2).
//   GET /v2/org-keys/<org>    — an organization's key document
//   GET /v2/repository-keys   — the repository delegation
//   GET /v2/revocations       — the current revocation statement
//
// Read-only, public, hit by every install. Two distinctions carry this file.
//
// 404 vs 503. A 404 says "this organization has no document", which a client
// reads as the legacy unsigned path — so returning one for a transient
// storage fault converts an outage into a fleet-wide verification bypass,
// with no error anywhere (§2.3). Every failure that is not "absent" is a 503.
//
// Cached vs not. Organization documents and the delegation change roughly
// annually and cache for hours. A revocation must not cache at all: it is the
// document whose whole value is arriving late-breaking, and a cached one is a
// revocation an attacker gets for free.
import { Hono } from 'hono';
import type { Env } from '../types';
import type { DocumentKind } from '../lib/envelope';

export const trust = new Hono<{ Bindings: Env }>();

/** Organization documents and the delegation, absent a shorter expiry. */
const DEFAULT_MAX_AGE = 6 * 3600;

/**
 * The cache policy for a document kind — the ONLY place one is decided, so a
 * new endpoint cannot pick its own by omission.
 *
 * `remainingSeconds` clamps the lifetime to the document's own `not-after`. A
 * document cached past its expiry is a stale document the client never gets
 * to refuse, because it never sees it.
 */
export function cachePolicy(kind: DocumentKind, remainingSeconds: number): string {
  if (kind === 'revocations') return 'no-store';
  const maxAge = Math.min(DEFAULT_MAX_AGE, Math.max(0, remainingSeconds));
  return maxAge > 0 ? `public, max-age=${maxAge}` : 'no-store';
}

async function serve(
  c: { env: Env },
  kind: DocumentKind,
  subject: string,
): Promise<Response> {
  let row: { envelope: string; not_after: string | null } | null;
  try {
    row = await c.env.DB.prepare(
      'SELECT envelope, not_after FROM signed_documents WHERE kind = ? AND subject = ?',
    )
      .bind(kind, subject)
      .first<{ envelope: string; not_after: string | null }>();
  } catch (e) {
    // NEVER 404 here. See the header: absence and unavailability mean
    // opposite things to a client, and only one of them disables checking.
    // no-store because caching a failure turns a transient outage into a
    // persistent one.
    return new Response(
      JSON.stringify({
        error: `document store unavailable: ${(e as Error).message}`,
      }),
      {
        status: 503,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        },
      },
    );
  }

  if (!row) return absent(kind, subject);

  // An expired document is served as though absent, and warned about. Serving
  // it would push the refusal onto every client at once — the same outcome as
  // absence, arrived at loudly and later.
  const expiresAt = row.not_after ? Date.parse(row.not_after) : NaN;
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    console.warn(
      `[trust] ${kind}${subject ? ' ' + subject : ''} EXPIRED at ` +
        `${row.not_after} and is being served as absent; re-sign it`,
    );
    return absent(kind, subject);
  }

  const remaining = Number.isFinite(expiresAt)
    ? Math.floor((expiresAt - Date.now()) / 1000)
    : DEFAULT_MAX_AGE;

  // The envelope goes back verbatim (§2.1). It is never parsed on the way
  // out: a parsed-and-reserialised document does not verify.
  return new Response(row.envelope, {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cachePolicy(kind, remaining),
    },
  });
}

function absent(kind: DocumentKind, subject: string): Response {
  return new Response(
    JSON.stringify({
      error:
        kind === 'org-keys'
          ? `no key document for organization '${subject}'`
          : `this repository serves no ${kind}`,
    }),
    {
      status: 404,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // A 404 here is a fact about the repository's current state, not a
        // durable one — an organization onboarding minutes from now must not
        // be shadowed by a cached absence.
        'Cache-Control': 'no-store',
      },
    },
  );
}

trust.get('/v2/org-keys/:org', (c) => serve(c, 'org-keys', c.req.param('org')));
trust.get('/v2/repository-keys', (c) => serve(c, 'repository-keys', ''));
trust.get('/v2/revocations', (c) => serve(c, 'revocations', ''));
