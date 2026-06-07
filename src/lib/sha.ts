// Content addressing. The canonical digest form on the wire and in the
// catalog is "sha256:<hex>"; the URL/R2-key form is the bare lowercase hex
// (matches the C++ client, which strips the prefix for /v2/blob/<hex> and
// keeps the full string for its workstation cache key).

const PREFIX = 'sha256:';

export async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function sha256Canonical(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  return PREFIX + (await sha256Hex(bytes));
}

/** Bare lowercase hex, prefix stripped if present. */
export function toHex(sha: string): string {
  return sha.startsWith(PREFIX) ? sha.slice(PREFIX.length) : sha;
}

/** Canonical "sha256:<hex>" form, prefix added if absent. */
export function toCanonical(sha: string): string {
  return sha.startsWith(PREFIX) ? sha : PREFIX + sha;
}

export function isHex64(s: string): boolean {
  return /^[0-9a-f]{64}$/.test(s);
}
