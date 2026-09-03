// The publishing organization's own signed key document (spec §4, §5).
//
// This file is what replaces name-derived ownership. Nothing in it reads the
// archive's name to decide who owns anything: the organization arrives from
// the authenticated principal, and everything else — which keys may sign, and
// which names they may sign for — comes from a root-signed document keyed by
// that organization.
//
// The stored envelope is re-verified against the root on every load. It was
// already verified when it was stored, so this is defence in depth and costs
// one Ed25519 verify on a path that already does several: it means a write
// into `signed_documents` from anywhere other than the administrative
// endpoint authorises nothing on its own.
import type { Env } from '../types';
import { rootKeys, verifyEnvelope, type TrustedKey } from './envelope';

export interface OrganizationKey extends TrustedKey {
  /** Epoch millis. A key outside its own window authorises nothing. */
  notBefore: number;
  notAfter: number;
}

export interface OrganizationDocument {
  organization: string;
  /** The signed list. The server checks this and so does the client (§4.1). */
  namespaces: string[];
  notAfter: number;
  keys: OrganizationKey[];
}

/**
 * Why an organization has no usable document. These are separate values
 * because they send an operator to different places: `absent` means nobody
 * signed one, `unverified` means one is stored that the root does not vouch
 * for, and `no-root` is a deployment misconfiguration on our side rather
 * than anything the publisher did.
 */
export type LoadFailure = 'absent' | 'unverified' | 'expired' | 'no-root';

export type OrganizationLookup =
  | { ok: true; document: OrganizationDocument }
  | { ok: false; reason: LoadFailure };

function stamp(v: unknown): number {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? NaN : t;
}

function parseKeys(raw: unknown): OrganizationKey[] {
  if (!Array.isArray(raw)) return [];
  const out: OrganizationKey[] = [];
  for (const k of raw) {
    if (!k || typeof k !== 'object') continue;
    const o = k as Record<string, unknown>;
    const id = o.id;
    const pem = o['public-key'];
    const notBefore = stamp(o['not-before']);
    const notAfter = stamp(o['not-after']);
    // An unparseable window is not an open one. A key whose dates we cannot
    // read is dropped rather than treated as always-valid.
    if (typeof id !== 'string' || typeof pem !== 'string') continue;
    if (Number.isNaN(notBefore) || Number.isNaN(notAfter)) continue;
    out.push({ id, pem, notBefore, notAfter });
  }
  return out;
}

/**
 * Load and re-verify the organization's current key document.
 *
 * Fails closed everywhere: an organization with no document, a document the
 * root does not verify, or one past its own `not-after` all yield a refusal.
 * Verification is not something a publisher declines by omission (§5.2).
 */
export async function loadOrganization(
  env: Env,
  organization: string,
  now: number = Date.now(),
): Promise<OrganizationLookup> {
  const roots = rootKeys(env);
  if (roots.length === 0) {
    console.warn(
      '[trust] no CAJETA_ROOT_KEY_PEM/_ID configured: no organization ' +
        'document can be verified, so every upload is refused',
    );
    return { ok: false, reason: 'no-root' };
  }

  const row = await env.DB.prepare(
    "SELECT envelope FROM signed_documents WHERE kind = 'org-keys' AND subject = ?",
  )
    .bind(organization)
    .first<{ envelope: string }>();
  if (!row) return { ok: false, reason: 'absent' };

  let verified;
  try {
    verified = await verifyEnvelope(row.envelope, roots);
  } catch (e) {
    console.warn(
      `[trust] stored org document for '${organization}' does not verify ` +
        `against the root: ${String(e)}`,
    );
    return { ok: false, reason: 'unverified' };
  }
  // The kind discriminator is inside the signature and decides; the row's
  // `kind` column is an index, not evidence.
  if (verified.kind !== 'org-keys' || verified.subject !== organization) {
    console.warn(
      `[trust] document stored for '${organization}' is a ${verified.kind} ` +
        `for '${verified.subject}'`,
    );
    return { ok: false, reason: 'unverified' };
  }

  const notAfter = stamp(verified.notAfter);
  if (Number.isNaN(notAfter)) return { ok: false, reason: 'unverified' };
  if (now >= notAfter) return { ok: false, reason: 'expired' };

  const namespaces = (verified.payload.namespaces as unknown[] | undefined) ?? [];
  return {
    ok: true,
    document: {
      organization,
      namespaces: namespaces.filter(
        (n): n is string => typeof n === 'string' && n.length > 0,
      ),
      notAfter,
      keys: parseKeys(verified.payload.keys),
    },
  };
}

/** The keys usable right now. Matches the client's `usableAt` exactly. */
export function usableKeys(
  document: OrganizationDocument,
  now: number = Date.now(),
): OrganizationKey[] {
  return document.keys.filter((k) => now >= k.notBefore && now < k.notAfter);
}

/**
 * Segment-aware namespace matching (§4.3).
 *
 * `dev.cajeta` owns `dev.cajeta.http` and does NOT own `dev.cajetaevil`. A
 * plain `startsWith` passes every well-behaved example and fails against a
 * name chosen adversarially, which is the only kind that matters here.
 *
 * There is no derivation step. The namespace is a whole string out of the
 * signed document, so `uk.co.acme` and `uk.co.evil` are simply two different
 * namespaces — the §1.4.2 collapse onto `co.uk` has nothing to collapse.
 */
export function ownsName(namespaces: string[], name: string): boolean {
  return namespaces.some((ns) => name === ns || name.startsWith(`${ns}.`));
}
