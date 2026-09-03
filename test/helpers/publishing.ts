// Fixtures for the upload path. An upload now needs three things that used to
// be optional: an authenticated principal, a root-signed key document for the
// organization that principal names, and an archive signature made by a key
// inside that document. Building all three here keeps each test about the one
// refusal it is asserting.
import { env } from 'cloudflare:test';
import { tokenHash } from '../../src/lib/auth';
import { publish } from '../../src/routes/publish';
import { base64, makeEnvelope, publicKeyPem } from './documents';

export const FAR = '2099-01-01T00:00:00Z';
export const PAST = '2020-01-01T00:00:00Z';

export interface Org {
  organization: string;
  token: string;
  keyId: string;
  pair: CryptoKeyPair;
}

async function keypair(): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
}

export async function mintPublishToken(principal: string, token: string) {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO publish_tokens
       (token_hash, principal, scopes, created_at, expires_at)
     VALUES (?, ?, 'publish', ?, NULL)`,
  )
    .bind(await tokenHash(token), principal, new Date().toISOString())
    .run();
}

/**
 * Store a root-signed organization key document the way the administrative
 * endpoint does: the envelope TEXT verbatim, with the ordering columns lifted
 * out of the payload. The publish path re-verifies it against the root, so a
 * document that is merely present in this table authorises nothing.
 */
export async function storeOrgDocument(payload: Record<string, unknown>) {
  const envelope = await makeEnvelope({ payload });
  await env.DB.prepare(
    `INSERT OR REPLACE INTO signed_documents
       (kind, subject, envelope, issued_at, not_after, key_id, stored_at)
     VALUES ('org-keys', ?, ?, ?, ?, 'test-root-1', ?)`,
  )
    .bind(
      payload.organization as string,
      envelope,
      payload['issued-at'] as string,
      payload['not-after'] as string,
      new Date().toISOString(),
    )
    .run();
  return envelope;
}

/**
 * An organization with a publish token, a signing keypair, and a signed key
 * document naming that key over the given namespaces.
 *
 * `keyWindow` exists so a document whose only key has lapsed can be built
 * without waiting a year — §5.3's refusal needs a document that is itself
 * current and a key inside it that is not.
 */
export async function makeOrg(opts: {
  organization: string;
  namespaces?: string[];
  keyId?: string;
  keyWindow?: { notBefore: string; notAfter: string };
  document?: boolean;
}): Promise<Org> {
  const pair = await keypair();
  const keyId = opts.keyId ?? `${opts.organization}-publish-1`;
  const token = `olla-publish-${opts.organization}`;
  await mintPublishToken(opts.organization, token);

  if (opts.document !== false) {
    await storeOrgDocument({
      organization: opts.organization,
      namespaces: opts.namespaces ?? [opts.organization],
      'issued-at': '2026-09-02T00:00:00Z',
      'not-after': FAR,
      keys: [
        {
          id: keyId,
          algorithm: 'ed25519',
          'public-key': await publicKeyPem(pair),
          'not-before': opts.keyWindow?.notBefore ?? '2026-01-01T00:00:00Z',
          'not-after': opts.keyWindow?.notAfter ?? FAR,
        },
      ],
    });
  }
  return { organization: opts.organization, token, keyId, pair };
}

export async function signArchive(
  pair: CryptoKeyPair,
  bytes: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign('Ed25519', pair.privateKey, bytes),
  );
}

export interface PublishOptions {
  /** Sign with this keypair instead of the organization's own. */
  signWith?: CryptoKeyPair;
  /** Send this key-id instead of the organization's own. */
  keyId?: string;
  /** Omit the signature entirely. */
  unsigned?: boolean;
  /** Extra/overriding env bindings, e.g. ALLOW_UNSIGNED. */
  env?: Record<string, unknown>;
  body?: string;
}

export async function publishAs(
  org: Org,
  name: string,
  version: string,
  opts: PublishOptions = {},
): Promise<Response> {
  const bytes = new TextEncoder().encode(
    opts.body ?? `CAJETA-ARCHIVE\n${name}\n${version}\n`,
  );
  const form = new FormData();
  form.set('archive', new Blob([bytes]), `${name}-${version}.cja`);
  form.set('metadata', JSON.stringify({ name, version }));
  form.set('manifest', JSON.stringify({ description: `${name} fixture` }));

  if (!opts.unsigned) {
    const sig = await signArchive(opts.signWith ?? org.pair, bytes);
    form.set('signature', new Blob([sig]), `${name}.sig`);
    form.set('key-id', opts.keyId ?? org.keyId);
  }

  return publish.fetch(
    new Request('https://olla.cajeta.dev/v2/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${org.token}` },
      body: form,
    }),
    { ...env, ...(opts.env ?? {}) } as typeof env,
  );
}

export function b64(bytes: Uint8Array): string {
  return base64(bytes);
}
