// Plan 4.1.1 – 4.1.7. Spec §2.6 – §2.9, §4.5.
//
// Release metadata is what binds an artifact's bytes to the organization that
// published it. Two properties carry this file.
//
// The organization comes from the AUTHENTICATED PRINCIPAL, never from the
// archive's name (§4.5). A name is a string anyone can choose; deriving
// ownership from it is the defect the whole spec exists to remove.
//
// The signed half is authoritative and the plain half is never merged into it
// (§2.7). Both are served so one response satisfies a verifying and a
// non-verifying client, and a mirror editing the plain half changes nothing.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import { publish } from '../../src/routes/publish';
import { resolve } from '../../src/routes/resolve';
import { fromBase64 } from '../../src/lib/signature';
import { makeOrg, publishAs, type Org } from '../helpers/publishing';

const PRINCIPAL = 'dev.release';

// A throwaway delegated release key, minted per run. Signing happens with
// RELEASE_SIGNING_KEY_PEM; production holds the real one as a Worker secret.
let releaseKeyPem: string;
let org: Org;

function pem(der: ArrayBuffer, label: string): string {
  let s = '';
  for (const b of new Uint8Array(der)) s += String.fromCharCode(b);
  return `-----BEGIN ${label}-----\n${btoa(s).replace(/(.{64})/g, '$1\n')}\n-----END ${label}-----\n`;
}

function releaseEnv(over: Record<string, unknown> = {}) {
  return {
    RELEASE_SIGNING_KEY_PEM: releaseKeyPem,
    RELEASE_SIGNING_KEY_ID: 'release-1',
    ...over,
  };
}

function envWithKey(over: Record<string, unknown> = {}) {
  return { ...env, ...releaseEnv(over) } as typeof env;
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  releaseKeyPem = pem(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    'PRIVATE KEY',
  );

  // The upload refusals apply here too (§5.1.8), so these fixtures publish the
  // way a real publisher does: a signed key document, and an archive signature
  // made by a key inside it. `evil.example` is a namespace this organization
  // legitimately holds — which is what makes the §4.5 assertion below sharp.
  org = await makeOrg({
    organization: PRINCIPAL,
    namespaces: [PRINCIPAL, 'evil.example'],
    keyId: 'release-tests-1',
  });
});

async function doPublish(name: string, version: string, body?: string) {
  return publishAs(org, name, version, { env: releaseEnv(), body });
}

async function doResolve(name: string, version: string) {
  const res = await resolve.fetch(
    new Request(
      `https://olla.cajeta.dev/v2/resolve?name=${name}&version=${version}`,
    ),
    envWithKey(),
  );
  return { res, body: (await res.json()) as Record<string, any> };
}

function signedPayload(body: Record<string, any>): Record<string, any> {
  return JSON.parse(new TextDecoder().decode(fromBase64(body.signed.payload)));
}

describe('signed release metadata', () => {
  beforeAll(async () => {
    expect((await doPublish('dev.release.http', '1.0.0')).status).toBe(201);
  });

  it('carries the signed envelope under `signed` (4.1.1)', async () => {
    const { body } = await doResolve('dev.release.http', '1.0.0');
    expect(body.signed).toBeTruthy();
    expect(body.signed.format).toBe(1);
    expect(body.signed['root-key-id']).toBe('release-1');
    expect(typeof body.signed.payload).toBe('string');
    expect(typeof body.signed.signature).toBe('string');
  });

  it('signs sha256, organization, name and version (4.1.2)', async () => {
    const { body } = await doResolve('dev.release.http', '1.0.0');
    const payload = signedPayload(body);
    expect(payload.name).toBe('dev.release.http');
    expect(payload.version).toBe('1.0.0');
    expect(payload.sha256).toBe(body.sha256);
    expect(payload.organization).toBe(PRINCIPAL);
  });

  it('verifies against the delegated release key', async () => {
    const { body } = await doResolve('dev.release.http', '1.0.0');
    const pair = await crypto.subtle.importKey(
      'pkcs8',
      fromBase64(releaseKeyPem.replace(/-----[^-]+-----|\s+/g, '')),
      { name: 'Ed25519' },
      false,
      ['sign'],
    );
    // Re-sign the same payload bytes and compare: identical input, identical
    // Ed25519 output, so this proves the envelope was made by this key.
    const bytes = fromBase64(body.signed.payload);
    const again = new Uint8Array(
      await crypto.subtle.sign('Ed25519', pair, bytes),
    );
    expect(body.signed.signature).toBe(btoa(String.fromCharCode(...again)));
  });

  // §4.5, and the reason the whole spec exists. `evil.example.thing` is
  // published by dev.release; the signed organization must say dev.release.
  it('takes organization from the principal, not the name (4.1.3)', async () => {
    expect((await doPublish('evil.example.thing', '2.0.0')).status).toBe(201);
    const { body } = await doResolve('evil.example.thing', '2.0.0');
    expect(signedPayload(body).organization).toBe(PRINCIPAL);
    expect(signedPayload(body).organization).not.toBe('evil.example');
  });

  it('still serves the plain half beside it (4.1.4)', async () => {
    const { body } = await doResolve('dev.release.http', '1.0.0');
    expect(body.name).toBe('dev.release.http');
    expect(body.sha256).toBeTruthy();
    expect(body.retracted).toBe(false);
  });

  // The halves may disagree without the signed one moving. A mirror that
  // edits the plain flag changes nothing a verifying client sees.
  it('does not let the plain half change the signed one (4.1.4)', async () => {
    await env.DB.prepare(
      "UPDATE versions SET retracted = 1, retracted_reason = 'tampered' WHERE name = ? AND version = ?",
    )
      .bind('dev.release.http', '1.0.0')
      .run();

    const { body } = await doResolve('dev.release.http', '1.0.0');
    expect(body.retracted).toBe(true);
    expect(signedPayload(body).retracted).toBeFalsy();

    await env.DB.prepare(
      "UPDATE versions SET retracted = 0, retracted_reason = '' WHERE name = ? AND version = ?",
    )
      .bind('dev.release.http', '1.0.0')
      .run();
  });
});

describe('retraction re-signs (4.1.5, 4.1.6)', () => {
  async function retract(name: string, version: string, reason: string) {
    return publish.fetch(
      new Request('https://olla.cajeta.dev/v2/retract', {
        method: 'POST',
        headers: { Authorization: `Bearer ${org.token}` },
        body: JSON.stringify({ name, version, reason }),
      }),
      envWithKey(),
    );
  }

  async function unretract(name: string, version: string) {
    return publish.fetch(
      new Request('https://olla.cajeta.dev/v2/unretract', {
        method: 'POST',
        headers: { Authorization: `Bearer ${org.token}` },
        body: JSON.stringify({ name, version }),
      }),
      envWithKey(),
    );
  }

  beforeAll(async () => {
    expect((await doPublish('dev.release.yank', '1.0.0')).status).toBe(201);
  });

  it('sets retracted INSIDE the signed payload (4.1.5)', async () => {
    expect((await retract('dev.release.yank', '1.0.0', 'bad release')).status).toBe(200);

    const { body } = await doResolve('dev.release.yank', '1.0.0');
    const payload = signedPayload(body);
    expect(payload.retracted).toBe(true);
    expect(payload['retracted-reason']).toBe('bad release');
    // and the plain half agrees, for clients that do not verify
    expect(body.retracted).toBe(true);
  });

  it('un-retracts, re-signing again (4.1.6)', async () => {
    expect((await unretract('dev.release.yank', '1.0.0')).status).toBe(200);
    const { body } = await doResolve('dev.release.yank', '1.0.0');
    expect(signedPayload(body).retracted).toBe(false);
    expect(body.retracted).toBe(false);
  });

  it('audits both (4.1.6, §3.10)', async () => {
    const { results } = await env.DB.prepare(
      "SELECT action FROM audit_log WHERE target = 'dev.release.yank@1.0.0' ORDER BY seq",
    ).all<{ action: string }>();
    expect(results.map((r) => r.action)).toEqual([
      'release.publish',
      'release.retract',
      'release.unretract',
    ]);
  });
});

// §2.9, asserted over the catalog rather than one release. Answering 404 on
// resolve for a coordinate whose bytes are still downloadable downgrades the
// client to the unsigned sidecar and loses the publisher binding while the
// install still succeeds. No client can detect that, so it is the server's
// obligation.
describe('every servable release resolves (4.1.7)', () => {
  it('holds across the whole catalog', async () => {
    const { results } = await env.DB.prepare(
      'SELECT name, version FROM versions',
    ).all<{ name: string; version: string }>();
    expect(results.length).toBeGreaterThan(2);

    for (const row of results) {
      const { res } = await doResolve(row.name, row.version);
      expect(res.status, `${row.name}@${row.version} has bytes but does not resolve`).toBe(200);
    }
  });
});
