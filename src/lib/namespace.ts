// Namespace ownership proof (§15). A publisher proves control of a domain by
// placing a token (their key fingerprint) in either:
//   - a DNS TXT record at `_cajeta-publish.<domain>`, or
//   - a file `.github/cajeta-publish.txt` in `<owner>/<repo>` (github method).
// The check runs server-side (over DNS-over-HTTPS / raw.githubusercontent) and
// is opaque to the client. Verified proofs are cached in the `namespaces`
// table. Enforcement on publish is gated by REQUIRE_NAMESPACE.
import type { Env } from '../types';

export async function verifyDnsTxt(domain: string, token: string): Promise<boolean> {
  const name = `_cajeta-publish.${domain}`;
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(
    name,
  )}&type=TXT`;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return false;
    const data = (await res.json()) as { Answer?: { data?: string }[] };
    for (const a of data.Answer ?? []) {
      const txt = String(a.data ?? '').replace(/^"|"$/g, '');
      if (txt.includes(token)) return true;
    }
  } catch {
    /* network / DoH failure → not verified */
  }
  return false;
}

export async function verifyGithub(
  owner: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.github/cajeta-publish.txt`;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'olla-registry' } });
    if (!res.ok) return false;
    return (await res.text()).includes(token);
  } catch {
    return false;
  }
}

export async function recordNamespace(
  env: Env,
  domain: string,
  owner: string,
  method: string,
  proof: string,
  now: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO namespaces (owner, domain, method, proof, verified_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET
       owner = excluded.owner, method = excluded.method,
       proof = excluded.proof, verified_at = excluded.verified_at`,
  )
    .bind(owner, domain, method, proof, now)
    .run();
}

export async function isNamespaceVerified(
  env: Env,
  domain: string,
  owner: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    'SELECT owner FROM namespaces WHERE domain = ? AND verified_at IS NOT NULL',
  )
    .bind(domain)
    .first<{ owner: string }>();
  return !!row && row.owner === owner;
}

/** Derive the namespace domain a package name claims: the first two
 *  dot-segments reversed (`com.acme.widgets` → `acme.com`). Best-effort. */
export function domainForPackage(name: string): string | null {
  const parts = name.split('.');
  if (parts.length < 2) return null;
  return `${parts[1]}.${parts[0]}`;
}
