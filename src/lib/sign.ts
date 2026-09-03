// Release metadata signing (publisher-trust §2.6).
//
// Signed on every publish, so the key has to be reachable by request-handling
// code — which is exactly why it is NOT the root. The root signs organization
// documents and the delegation, both rare, and stays offline; this delegated
// key does the per-publish work. A compromise here forges release metadata
// and nothing else, and rotating it out is one offline signature rather than
// a new toolchain release.
import type { Env } from '../types';
import { base64, signDetached } from './signature';

export interface ReleasePayload {
  name: string;
  version: string;
  sha256: string;
  /** From the authenticated principal, never the archive name (§4.5). */
  organization: string;
  retracted?: boolean;
  'retracted-reason'?: string;
}

/**
 * Build and sign the envelope. Returns the envelope TEXT, exactly as it will
 * be stored and served — the payload is base64 of the UTF-8 JSON and the
 * signature covers those decoded bytes, with no canonical-JSON step.
 *
 * Returns null when no release key is configured. That is the pre-delegation
 * shape: the plain half is still served and a client verifies against the
 * roots directly or not at all (§2.7.3). It is a legitimate state, not a
 * silent failure — but it is warned about, because in production it means a
 * missing secret and every release published meanwhile is unsigned.
 */
export async function signRelease(
  env: Env,
  payload: ReleasePayload,
): Promise<string | null> {
  const pem = env.RELEASE_SIGNING_KEY_PEM;
  const keyId = env.RELEASE_SIGNING_KEY_ID;
  if (!pem || !keyId) {
    console.warn(
      `[trust] no RELEASE_SIGNING_KEY_PEM/_ID: ${payload.name}@${payload.version} ` +
        'is published UNSIGNED and no client can bind it to a publisher',
    );
    return null;
  }

  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const signature = base64(await signDetached(pem, bytes));

  return JSON.stringify({
    format: 1,
    // Named root-key-id because the envelope is shared with every other
    // signed document, not because a root signed it: here it names the
    // DELEGATED key, and the client reports whichever key actually verified.
    'root-key-id': keyId,
    payload: base64(bytes),
    signature,
  });
}
