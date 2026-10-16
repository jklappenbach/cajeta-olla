// olla-worker-signing plan 1.1.1 – 1.1.11. Spec §2, §3.1, §3.2, §4.1, §5.1.
import { env } from 'cloudflare:test';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { publish } from '../../src/routes/publish';
import { capabilities } from '../../src/routes/capabilities';
import { putBinding } from '../../src/lib/publishers';
import { heldKey } from '../../src/lib/held-keys';
import { verifyDetached, fromBase64 } from '../../src/lib/signature';
import { makeOrg, publishAs, signArchive, PAST, type Org } from '../helpers/publishing';
import { publicKeyPem } from '../helpers/documents';
import { githubClaims, keySet, makeSigner, mintIdentityToken, type Signer } from '../helpers/identity';

let gh: Signer;
let org: Org;
let lapsed: Org;

async function privatePem(pair: CryptoKeyPair): Promise<string> {
  const der = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

async function held(o: Org, over: { keyId?: string; pair?: CryptoKeyPair } = {}) {
  return JSON.stringify({
    [o.organization]: { 'key-id': over.keyId ?? o.keyId, 'private-key': await privatePem(over.pair ?? o.pair) },
  });
}

async function identityPublish(
  repository: string,
  name: string,
  version: string,
  opts: { keys?: string; sign?: Org; sigOnly?: boolean; keyIdOnly?: string } = {},
) {
  const bytes = new TextEncoder().encode(`CAJETA-ARCHIVE\n${name}\n${version}\n`);
  const form = new FormData();
  form.set('archive', new Blob([bytes]), `${name}-${version}.cja`);
  form.set('metadata', JSON.stringify({ name, version }));
  form.set('manifest', JSON.stringify({ description: `${name} fixture` }));
  if (opts.sign) {
    form.set('signature', new Blob([await signArchive(opts.sign.pair, bytes)]), `${name}.sig`);
    if (!opts.sigOnly) form.set('key-id', opts.sign.keyId);
  }
  if (opts.keyIdOnly) form.set('key-id', opts.keyIdOnly);
  const token = await mintIdentityToken(gh, githubClaims({ repository }));
  const res = await publish.fetch(
    new Request('https://olla.cajeta.dev/v2/publish', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }),
    { ...env, OIDC_JWKS_JSON: keySet(gh), ...(opts.keys ? { ORG_SIGNING_KEYS: opts.keys } : {}) } as typeof env,
  );
  return { res, bytes };
}

async function auditAfter(target: string) {
  const row = await env.DB.prepare(
    `SELECT after_state FROM audit_log WHERE target = ? ORDER BY seq DESC LIMIT 1`,
  )
    .bind(target)
    .first<{ after_state: string }>();
  return JSON.parse(row!.after_state);
}

beforeAll(async () => {
  gh = await makeSigner('gh-srv-1');
  org = await makeOrg({ organization: 'dev.srvsign', namespaces: ['dev.srvsign'] });
  lapsed = await makeOrg({
    organization: 'dev.srvlapsed',
    keyWindow: { notBefore: PAST, notAfter: '2021-01-01T00:00:00Z' },
  });
  await putBinding(env, { provider: 'github', repository: 'jklappenbach/srv-lib', organization: 'dev.srvsign' }, 'owner');
  await putBinding(env, { provider: 'github', repository: 'jklappenbach/srv-lapsed', organization: 'dev.srvlapsed' }, 'owner');
  await putBinding(env, { provider: 'github', repository: 'jklappenbach/srv-nokey', organization: 'dev.srvnokey' }, 'owner');
  await makeOrg({ organization: 'dev.srvnokey' });
});

afterEach(() => vi.restoreAllMocks());

describe('heldKey', () => {
  it('1.1.1 finds an organization, and is null when absent, unset, or malformed', async () => {
    const keys = await held(org);
    const k = heldKey({ ...env, ORG_SIGNING_KEYS: keys } as typeof env, 'dev.srvsign');
    expect(k?.keyId).toBe(org.keyId);
    expect(k?.pem).toContain('BEGIN PRIVATE KEY');
    expect(heldKey({ ...env, ORG_SIGNING_KEYS: keys } as typeof env, 'dev.other')).toBeNull();
    expect(heldKey({ ...env, ORG_SIGNING_KEYS: undefined } as typeof env, 'dev.srvsign')).toBeNull();
    expect(heldKey({ ...env, ORG_SIGNING_KEYS: '{not json' } as typeof env, 'dev.srvsign')).toBeNull();
  });
});

describe('the Worker signs an unsigned identity upload', () => {
  it('1.1.2 lands, and the stored signature verifies against the document key', async () => {
    const { res, bytes } = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.a', '1.0.0', {
      keys: await held(org),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const row = await env.DB.prepare(
      `SELECT signature, key_id FROM versions WHERE name = ? AND version = ?`,
    )
      .bind('dev.srvsign.a', '1.0.0')
      .first<{ signature: string; key_id: string }>();
    expect(row?.key_id).toBe(org.keyId);
    expect(await verifyDetached(await publicKeyPem(org.pair), fromBase64(row!.signature), bytes)).toBe(true);
  });

  it('1.1.3 a held key-id outside the document, or outside its window, is refused as a client key is', async () => {
    const ghost = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.b', '1.0.0', {
      keys: await held(org, { keyId: 'ghost-1' }),
    });
    expect(ghost.res.status).toBe(403);
    expect(await ghost.res.text()).toMatch(/not in the signed key document/);

    const old = await identityPublish('jklappenbach/srv-lapsed', 'dev.srvlapsed.b', '1.0.0', {
      keys: await held(lapsed),
    });
    expect(old.res.status).toBe(403);
    expect(await old.res.text()).toMatch(/outside its own validity window/);
  });

  it('1.1.4 a client-signed identity upload is verified as today and the held key is unused', async () => {
    const stranger = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const { res } = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.c', '1.0.0', {
      keys: await held(org, { pair: stranger }),
      sign: org,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    expect((await auditAfter('dev.srvsign.c@1.0.0'))['signed-by']).toBe('client');
  });

  it('1.1.5 a signature without a key-id, or a key-id without a signature, is refused', async () => {
    const keys = await held(org);
    const a = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.d', '1.0.0', { keys, sign: org, sigOnly: true });
    expect(a.res.status).toBe(400);
    expect(await a.res.text()).toMatch(/no key-id/);
    const b = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.d', '1.0.1', { keys, keyIdOnly: org.keyId });
    expect(b.res.status).toBe(400);
    expect(await b.res.text()).toMatch(/unsigned/);
  });

  it('1.1.6 an organization with no held key is 403 naming the missing server-held key', async () => {
    const { res } = await identityPublish('jklappenbach/srv-nokey', 'dev.srvnokey.e', '1.0.0', {
      keys: await held(org),
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/no server-held key/);
  });

  it('1.1.7 an unsigned token upload is refused even when a key is held', async () => {
    const r = await publishAs(org, 'dev.srvsign.f', '1.0.0', {
      unsigned: true,
      env: { ORG_SIGNING_KEYS: await held(org) },
    });
    expect(r.status).toBe(400);
    expect(await r.text()).toMatch(/unsigned/);
  });

  it('1.1.8 a held key that does not match the document is a 500 server fault', async () => {
    const wrong = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const { res } = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.g', '1.0.0', {
      keys: await held(org, { pair: wrong }),
    });
    expect(res.status).toBe(500);
    expect(await res.text()).toMatch(/server fault/i);
  });

  it('1.1.9 the audit row says who signed, with the key-id', async () => {
    const { res } = await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.h', '1.0.0', {
      keys: await held(org),
    });
    expect(res.status).toBe(201);
    const after = await auditAfter('dev.srvsign.h@1.0.0');
    expect(after['signed-by']).toBe('server');
    expect(after['key-id']).toBe(org.keyId);
  });

  it('1.1.10 capabilities advertise server signing for github', async () => {
    const r = await capabilities.fetch(new Request('https://olla.cajeta.dev/.well-known/cajeta-capabilities.json'), env);
    const doc = (await r.json()) as { capabilities: { 'server-signing'?: string[] } };
    expect(doc.capabilities['server-signing']).toEqual(['github']);
  });

  it('1.1.11 the held private key reaches no response and no log line', async () => {
    const keys = await held(org);
    const secret = JSON.parse(keys)[org.organization]['private-key'].split('\n')[1];
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    }
    const bodies: string[] = [];
    bodies.push(await (await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.i', '1.0.0', { keys })).res.text());
    bodies.push(await (await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.i', '1.0.0', { keys })).res.text());
    const wrong = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const bad = await held(org, { pair: wrong });
    bodies.push(await (await identityPublish('jklappenbach/srv-lib', 'dev.srvsign.j', '1.0.0', { keys: bad })).res.text());
    const wrongSecret = JSON.parse(bad)[org.organization]['private-key'].split('\n')[1];
    for (const text of [...bodies, ...lines]) {
      expect(text).not.toContain(secret);
      expect(text).not.toContain(wrongSecret);
    }
  });
});
