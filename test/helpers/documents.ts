// Builds signed envelopes the way the operator's olla-key toolkit does:
// payload → UTF-8 JSON → base64, signature over the DECODED payload bytes.
// Nothing here re-serialises a payload after signing it.
import { env } from 'cloudflare:test';

export interface EnvelopeParts {
  format?: number;
  keyId?: string;
  payload: unknown;
  /** Overrides the signature, for the tamper cases. */
  signature?: string;
}

function pemToDer(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export async function testRootKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    pemToDer(env.TEST_ROOT_KEY_PEM),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
}

/** An Ed25519 keypair that is NOT the trusted root. */
export async function foreignKey() {
  return crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ]) as Promise<CryptoKeyPair>;
}

export async function publicKeyPem(pair: CryptoKeyPair): Promise<string> {
  const der = new Uint8Array(
    (await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer,
  );
  const b64 = base64(der).replace(/(.{64})/g, '$1\n');
  return `-----BEGIN PUBLIC KEY-----\n${b64}\n-----END PUBLIC KEY-----\n`;
}

/** Serialise + sign. Returns the envelope TEXT, which is what gets stored. */
export async function makeEnvelope(
  parts: EnvelopeParts,
  signWith?: CryptoKey,
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(parts.payload));
  const key = signWith ?? (await testRootKey());
  const signature =
    parts.signature ??
    base64(
      new Uint8Array(await crypto.subtle.sign('Ed25519', key, payloadBytes)),
    );

  return JSON.stringify({
    format: parts.format ?? 1,
    'root-key-id': parts.keyId ?? 'test-root-1',
    payload: base64(payloadBytes),
    signature,
  });
}

const YEAR_AWAY = '2099-01-01T00:00:00Z';

export function orgDocument(over: Record<string, unknown> = {}) {
  return {
    organization: 'dev.cajeta',
    namespaces: ['dev.cajeta'],
    'issued-at': '2026-09-02T00:00:00Z',
    'not-after': YEAR_AWAY,
    keys: [
      {
        id: 'publish-1',
        algorithm: 'ed25519',
        'public-key': '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
        'not-before': '2026-01-01T00:00:00Z',
        'not-after': YEAR_AWAY,
      },
    ],
    ...over,
  };
}

export function delegation(over: Record<string, unknown> = {}) {
  return {
    type: 'repository-delegation',
    repository: 'https://olla.cajeta.dev',
    'issued-at': '2026-01-01T00:00:00Z',
    'not-after': YEAR_AWAY,
    keys: [
      {
        id: 'release-1',
        algorithm: 'ed25519',
        'public-key': '-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n',
        'not-before': '2026-01-01T00:00:00Z',
        'not-after': YEAR_AWAY,
      },
    ],
    ...over,
  };
}

export function revocation(over: Record<string, unknown> = {}) {
  return {
    type: 'key-revocation',
    repository: 'https://olla.cajeta.dev',
    'issued-at': '2026-09-02T00:00:00Z',
    'not-after': YEAR_AWAY,
    revoked: [{ id: 'publish-1', organization: 'dev.cajeta' }],
    ...over,
  };
}
