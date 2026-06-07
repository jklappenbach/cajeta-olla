// Ed25519 signatures (§15), matching the Cajeta build tool's scheme exactly
// (src/cajeta/buildtool/actions/SignAction.cpp / VerifySigAction.cpp):
//
//   - Pure Ed25519 (no pre-hash), signature computed over the RAW .cja bytes.
//   - The detached signature is 64 raw bytes (the `signature` multipart field).
//   - Public keys are PEM (SubjectPublicKeyInfo / SPKI); private keys PKCS#8.
//   - key-id is an opaque label mapping to a trusted public key (trust store).
//
// Web Crypto's "Ed25519" (supported by workerd) covers verify + sign.

function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function importPublicKeyPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('spki', pemToDer(pem), { name: 'Ed25519' }, false, [
    'verify',
  ]);
}

export async function importPrivateKeyPem(pem: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('pkcs8', pemToDer(pem), { name: 'Ed25519' }, false, [
    'sign',
  ]);
}

/** Verify a detached 64-byte Ed25519 signature over `message`. */
export async function verifyDetached(
  publicKeyPem: string,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<boolean> {
  try {
    const key = await importPublicKeyPem(publicKeyPem);
    return await crypto.subtle.verify('Ed25519', key, signature, message);
  } catch {
    return false;
  }
}

export async function signDetached(
  privateKeyPem: string,
  message: Uint8Array,
): Promise<Uint8Array> {
  const key = await importPrivateKeyPem(privateKeyPem);
  const sig = await crypto.subtle.sign('Ed25519', key, message);
  return new Uint8Array(sig);
}

/** Lowercase-hex SHA-256 fingerprint of an SPKI public key (matches the build
 *  tool's `openssl pkey -pubout | sha256sum` fingerprint). */
export async function fingerprintOfPublicKeyPem(pem: string): Promise<string> {
  const der = pemToDer(pem);
  const digest = await crypto.subtle.digest('SHA-256', der);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function base64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ── Transparency-log signing (§15) ──
//
// The registry signs each log entry with its OWN Ed25519 log key (distinct
// from publishers' keys). The signed payload is the canonical
// `<sha256>\n<signed-at>` line; the signature is base64 on the wire.

export interface LogSignature {
  signatureB64: string;
  keyId: string;
}

export async function signLogEntry(
  logKeyPem: string | undefined,
  logKeyId: string | undefined,
  sha256Canonical: string,
  signedAt: string,
): Promise<LogSignature> {
  if (!logKeyPem || !logKeyId) return { signatureB64: '', keyId: '' };
  const payload = new TextEncoder().encode(`${sha256Canonical}\n${signedAt}`);
  const sig = await signDetached(logKeyPem, payload);
  return { signatureB64: base64(sig), keyId: logKeyId };
}
