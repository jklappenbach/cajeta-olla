// Signed-envelope verification (publisher-trust §3.2, §3.3).
//
// The payload travels as opaque base64 bytes and the signature covers those
// bytes EXACTLY as transmitted. There is no canonical-JSON step, so signer and
// verifier never have to agree on key order, whitespace or number formatting —
// and the classic signature-bypass bug, verifying a parsed-and-reserialised
// object, is unrepresentable here. Nothing in this file re-encodes a payload.
import type { Env } from '../types';
import { fromBase64, verifyDetached } from './signature';

export type DocumentKind = 'org-keys' | 'repository-keys' | 'revocations';

export interface TrustedKey {
  id: string;
  /** PEM SubjectPublicKeyInfo. */
  pem: string;
}

export interface VerifiedDocument {
  kind: DocumentKind;
  /** The envelope text as received, for byte-identical storage (§2.1). */
  envelope: string;
  payload: Record<string, unknown>;
  /** The key that ACTUALLY verified — not the envelope's own claim. */
  keyId: string;
  /** Organization for org-keys; '' for the repository-wide kinds. */
  subject: string;
  /**
   * When the document was produced. REQUIRED on all three kinds, and the
   * value the replay check (§3.4) orders by.
   *
   * The delegation acquired this late — it was specified before §2.9 existed
   * and the rule was written inside the organization-document section, so for
   * two days it was the one replayable document. Nothing justified the gap:
   * a superseded delegation is still validly signed and still inside its own
   * window, so serving last quarter's copy reinstates the release key that was
   * rotated out.
   */
  issuedAt: string;
  notAfter: string;
}

class EnvelopeError extends Error {}

/**
 * Which kind of document a payload declares itself to be.
 *
 * The `type` discriminator is inside the signature, so it cannot be added or
 * stripped in transit, and it decides — never the URL the document arrived at.
 * An organization document carries no `type` at all and is identified by the
 * organization and namespaces a delegation never has, so `type` is checked
 * FIRST: a payload carrying both must not be read as an organization document.
 */
export function identifyKind(payload: unknown): DocumentKind | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;

  if (typeof p.type === 'string') {
    if (p.type === 'repository-delegation') return 'repository-keys';
    if (p.type === 'key-revocation') return 'revocations';
    return null; // says it is something we do not know: never guess.
  }

  if (typeof p.organization === 'string' && Array.isArray(p.namespaces)) {
    return 'org-keys';
  }
  return null;
}

function field(o: Record<string, unknown>, name: string): string {
  const v = o[name];
  if (typeof v !== 'string' || v.length === 0) {
    throw new EnvelopeError(`envelope is missing '${name}'`);
  }
  return v;
}

/**
 * Verify an envelope against a set of candidate keys, returning the document
 * and the key that actually verified. Throws on anything short of a good
 * signature over a payload we can identify.
 */
export async function verifyEnvelope(
  envelope: string,
  candidates: TrustedKey[],
): Promise<VerifiedDocument> {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(envelope);
  } catch {
    throw new EnvelopeError('envelope is not JSON');
  }
  if (!outer || typeof outer !== 'object') {
    throw new EnvelopeError('envelope is not an object');
  }
  if (outer.format !== 1) {
    throw new EnvelopeError(`unsupported envelope format ${String(outer.format)}`);
  }
  field(outer, 'root-key-id');
  const payloadB64 = field(outer, 'payload');
  const signatureB64 = field(outer, 'signature');

  let payloadBytes: Uint8Array;
  let signature: Uint8Array;
  try {
    payloadBytes = fromBase64(payloadB64);
    signature = fromBase64(signatureB64);
  } catch {
    throw new EnvelopeError('payload or signature is not valid base64');
  }
  if (candidates.length === 0) {
    throw new EnvelopeError('no trusted key is available to verify against');
  }

  // verifyDetached takes the PEM and returns false for an unimportable key as
  // well as a bad signature. Both mean the same thing here: this candidate did
  // not verify, and an unusable trusted key is never a reason to accept.
  let verifiedBy: string | null = null;
  for (const candidate of candidates) {
    if (await verifyDetached(candidate.pem, signature, payloadBytes)) {
      verifiedBy = candidate.id;
      break;
    }
  }
  if (!verifiedBy) {
    throw new EnvelopeError('signature does not verify against any trusted key');
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new EnvelopeError('signed payload is not JSON');
  }

  const kind = identifyKind(payload);
  if (!kind) {
    throw new EnvelopeError('signed payload does not declare a document type');
  }

  const notAfter = field(payload, 'not-after');
  // Required on every kind. An optional issued-at cannot be checked — a
  // document omitting it would simply skip the replay comparison, which is
  // the whole attack.
  const issuedAt = field(payload, 'issued-at');

  return {
    kind,
    envelope,
    payload,
    keyId: verifiedBy,
    subject: kind === 'org-keys' ? field(payload, 'organization') : '',
    issuedAt,
    notAfter,
  };
}

/** The repository root, from public configuration. Never a secret (§3.1). */
export function rootKeys(env: Env): TrustedKey[] {
  if (!env.CAJETA_ROOT_KEY_PEM || !env.CAJETA_ROOT_KEY_ID) return [];
  return [{ id: env.CAJETA_ROOT_KEY_ID, pem: env.CAJETA_ROOT_KEY_PEM }];
}

/**
 * The keys named by the stored delegation — what a revocation is verified
 * against. Built FROM the delegation so a root signature on a revocation is
 * unrepresentable rather than merely rejected: the root is not in this list.
 */
export async function delegatedKeys(env: Env): Promise<TrustedKey[]> {
  const row = await env.DB.prepare(
    "SELECT envelope FROM signed_documents WHERE kind = 'repository-keys' AND subject = ''",
  ).first<{ envelope: string }>();
  if (!row) return [];

  try {
    const outer = JSON.parse(row.envelope) as { payload: string };
    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64(outer.payload)),
    ) as { keys?: { id?: string; 'public-key'?: string }[] };
    return (payload.keys ?? [])
      .filter((k) => typeof k.id === 'string' && typeof k['public-key'] === 'string')
      .map((k) => ({ id: k.id!, pem: k['public-key']! }));
  } catch {
    return [];
  }
}
