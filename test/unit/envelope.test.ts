// Plan 2.1.1, 2.1.2, 2.1.8, and the discriminator half of 2.1.3/2.1.4.
// Spec §3.2, §3.3.
//
// The payload travels as opaque bytes and the signature covers them exactly as
// transmitted. There is no canonical-JSON step, so every test here signs bytes
// and hands those same bytes to the verifier.
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { identifyKind, verifyEnvelope } from '../../src/lib/envelope';
import {
  base64,
  delegation,
  foreignKey,
  makeEnvelope,
  orgDocument,
  revocation,
} from '../helpers/documents';

const ROOT = () => env.CAJETA_ROOT_KEY_PEM!;

describe('verifyEnvelope', () => {
  it('accepts an envelope signed by the trusted root (2.1.1)', async () => {
    const text = await makeEnvelope({ payload: orgDocument() });
    const doc = await verifyEnvelope(text, [
      { id: 'test-root-1', pem: ROOT() },
    ]);
    expect(doc.kind).toBe('org-keys');
    expect(doc.subject).toBe('dev.cajeta');
    expect(doc.keyId).toBe('test-root-1');
  });

  it('REFUSES an envelope signed by any other key (2.1.2)', async () => {
    const other = await foreignKey();
    const text = await makeEnvelope({ payload: orgDocument() }, other.privateKey);
    await expect(
      verifyEnvelope(text, [{ id: 'test-root-1', pem: ROOT() }]),
    ).rejects.toThrow(/signature/i);
  });

  it('refuses a payload altered after signing', async () => {
    const text = await makeEnvelope({ payload: orgDocument() });
    const parsed = JSON.parse(text);
    parsed.payload = base64(
      new TextEncoder().encode(
        JSON.stringify(orgDocument({ namespaces: ['dev.evil'] })),
      ),
    );
    await expect(
      verifyEnvelope(JSON.stringify(parsed), [
        { id: 'test-root-1', pem: ROOT() },
      ]),
    ).rejects.toThrow(/signature/i);
  });

  it('refuses an unknown envelope format', async () => {
    const text = await makeEnvelope({ payload: orgDocument(), format: 2 });
    await expect(
      verifyEnvelope(text, [{ id: 'test-root-1', pem: ROOT() }]),
    ).rejects.toThrow(/format/i);
  });

  it('refuses an envelope missing a required field', async () => {
    const parsed = JSON.parse(await makeEnvelope({ payload: orgDocument() }));
    delete parsed.signature;
    await expect(
      verifyEnvelope(JSON.stringify(parsed), [
        { id: 'test-root-1', pem: ROOT() },
      ]),
    ).rejects.toThrow();
  });

  it('preserves the envelope byte for byte (2.1.8)', async () => {
    // Whitespace and key order a reserialiser would not reproduce.
    const payload = base64(
      new TextEncoder().encode(JSON.stringify(orgDocument())),
    );
    const key = await (await import('../helpers/documents')).testRootKey();
    const signature = base64(
      new Uint8Array(
        await crypto.subtle.sign(
          'Ed25519',
          key,
          new TextEncoder().encode(JSON.stringify(orgDocument())),
        ),
      ),
    );
    const text = `{\n  "format" : 1,\n    "root-key-id":"test-root-1",\n  "payload": "${payload}",\n  "signature": "${signature}"\n}\n`;

    const doc = await verifyEnvelope(text, [
      { id: 'test-root-1', pem: ROOT() },
    ]);
    expect(doc.envelope).toBe(text);
  });
});

describe('identifyKind', () => {
  it('reads an organization document from organization + namespaces', () => {
    expect(identifyKind(orgDocument())).toBe('org-keys');
  });

  it('reads a delegation from its signed type discriminator', () => {
    expect(identifyKind(delegation())).toBe('repository-keys');
  });

  it('reads a revocation from its signed type discriminator', () => {
    expect(identifyKind(revocation())).toBe('revocations');
  });

  it('refuses a payload that says it is nothing', () => {
    expect(identifyKind({ hello: 'world' })).toBeNull();
  });

  it('refuses a type it does not know', () => {
    expect(identifyKind({ type: 'something-else' })).toBeNull();
  });

  // An organization document carries no `type`, so a delegation's type must
  // win over the organization/namespaces shape rather than the other way
  // round. Otherwise a delegation carrying both would be read as an org
  // document and its keys trusted for the wrong purpose.
  it('lets the type discriminator win over document shape', () => {
    expect(
      identifyKind({
        type: 'repository-delegation',
        organization: 'dev.cajeta',
        namespaces: ['dev.cajeta'],
      }),
    ).toBe('repository-keys');
  });
});
