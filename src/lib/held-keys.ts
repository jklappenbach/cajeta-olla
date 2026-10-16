// Server-held organization signing keys (olla-worker-signing §3). One
// Cloudflare secret, ORG_SIGNING_KEYS, maps an organization to the key-id and
// PKCS#8 PEM the Worker signs that organization's identity uploads with.
import type { Env } from '../types';

export interface HeldKey {
  keyId: string;
  pem: string;
}

/** The key held for `organization`, or null when none is held or the secret is unreadable. */
export function heldKey(env: Env, organization: string): HeldKey | null {
  if (!env.ORG_SIGNING_KEYS) return null;
  let map: Record<string, { 'key-id'?: unknown; 'private-key'?: unknown }>;
  try {
    map = JSON.parse(env.ORG_SIGNING_KEYS);
  } catch {
    console.warn('[trust] ORG_SIGNING_KEYS is not valid JSON; no organization has a server-held key');
    return null;
  }
  const entry = Object.hasOwn(map, organization) ? map[organization] : undefined;
  if (typeof entry?.['key-id'] !== 'string' || typeof entry['private-key'] !== 'string') return null;
  return { keyId: entry['key-id'], pem: entry['private-key'] };
}
