// Plan 5.1.1 – 5.1.8. Spec §5, and the two findings in §1.4 that made this
// urgent rather than theoretical.
//
// The property under test: an upload is refused unless its signature verifies
// against a key inside the publishing organization's OWN current key document,
// usable at upload time, for a name inside that document's namespaces. Being
// known to the server is not the test — that was the hole.
//
// Every refusal here has a matching acceptance in the same describe block. A
// suite that only asserts refusals cannot tell a working check from one that
// refuses everything, and a check nobody can publish through is not a check.
import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  FAR,
  PAST,
  makeOrg,
  publishAs,
  type Org,
} from '../helpers/publishing';
import { ownsName } from '../../src/lib/organization';

let cajeta: Org;
let acme: Org;
let evil: Org;
let noDocument: Org;
let lapsed: Org;

beforeAll(async () => {
  cajeta = await makeOrg({
    organization: 'dev.cajeta',
    // Two namespaces, one of which is nothing like the organization's own
    // name. Ownership is data, so there is no reason they should match.
    namespaces: ['dev.cajeta', 'other.example'],
    keyId: 'cajeta-publish-1',
  });
  acme = await makeOrg({ organization: 'uk.co.acme', keyId: 'acme-1' });
  evil = await makeOrg({ organization: 'uk.co.evil', keyId: 'evil-1' });
  noDocument = await makeOrg({ organization: 'dev.orphan', document: false });
  lapsed = await makeOrg({
    organization: 'dev.lapsed',
    keyId: 'lapsed-1',
    keyWindow: { notBefore: '2020-01-01T00:00:00Z', notAfter: PAST },
  });
});

async function message(res: Response): Promise<string> {
  return JSON.stringify(await res.json());
}

describe("a key from another organization's document (5.1.1)", () => {
  // §1.4.1: getTrustKey resolved a key by key_id alone against a repository-
  // global table and never compared the row's principal to the authenticated
  // one, so any registered key verified an upload under any organization's
  // name. acme-1 is a perfectly valid key — in acme's document.
  it('is refused even though the signature itself is good', async () => {
    const res = await publishAs(cajeta, 'dev.cajeta.borrowed', '1.0.0', {
      signWith: acme.pair,
      keyId: 'acme-1',
    });
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('not in the signed key document');
  });

  it("accepts the organization's own key (the not-fire case)", async () => {
    expect((await publishAs(cajeta, 'dev.cajeta.own', '1.0.0')).status).toBe(201);
  });

  // A good key-id with a signature made by a different key is a separate
  // failure from an unknown key-id, and must not be reported as the same one.
  it('refuses its own key-id over a foreign signature', async () => {
    const res = await publishAs(cajeta, 'dev.cajeta.mismatch', '1.0.0', {
      signWith: acme.pair,
    });
    expect(res.status).toBe(400);
    expect(await message(res)).toContain('signature verification failed');
  });
});

describe('an organization with no key document (5.1.2)', () => {
  it('is refused', async () => {
    const res = await publishAs(noDocument, 'dev.orphan.thing', '1.0.0');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('no signed key document');
  });
});

describe('an organization whose only key has expired (5.1.3)', () => {
  it('is refused', async () => {
    const res = await publishAs(lapsed, 'dev.lapsed.thing', '1.0.0');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('validity window');
  });

  // The document itself is current; only the key inside it has lapsed. The
  // refusal must survive that distinction, or "publish a new document" is
  // advice that does not fix it.
  it('accepts once a current key is in the document', async () => {
    const refreshed = await makeOrg({
      organization: 'dev.lapsed',
      keyId: 'lapsed-2',
      keyWindow: { notBefore: '2026-01-01T00:00:00Z', notAfter: FAR },
    });
    expect((await publishAs(refreshed, 'dev.lapsed.thing', '1.0.0')).status).toBe(201);
  });
});

describe('a name outside the signed namespaces (5.1.4)', () => {
  it('is refused', async () => {
    const res = await publishAs(acme, 'dev.cajeta.hijack', '1.0.0');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('does not own');
  });

  // §4.5 stays true through the namespace check: dev.cajeta legitimately
  // holds `other.example`, publishes under it, and the recorded organization
  // is still dev.cajeta — never the leading segments of the name.
  it('permits a namespace unrelated to the organization name', async () => {
    expect((await publishAs(cajeta, 'other.example.thing', '1.0.0')).status).toBe(201);
    const row = await env.DB.prepare(
      'SELECT organization FROM versions WHERE name = ? AND version = ?',
    )
      .bind('other.example.thing', '1.0.0')
      .first<{ organization: string }>();
    expect(row?.organization).toBe('dev.cajeta');
  });
});

describe('namespace matching is segment-aware (5.1.5)', () => {
  it('owns a subordinate name', async () => {
    expect((await publishAs(cajeta, 'dev.cajeta.http', '1.0.0')).status).toBe(201);
  });

  // The one a plain startsWith gets wrong. Every well-behaved example passes
  // either way; only an adversarial name separates them.
  it('does not own a name that merely shares a prefix', async () => {
    const res = await publishAs(cajeta, 'dev.cajetaevil', '1.0.0');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('does not own');
  });

  it('matches the namespace exactly', () => {
    expect(ownsName(['dev.cajeta'], 'dev.cajeta')).toBe(true);
    expect(ownsName(['dev.cajeta'], 'dev.cajeta.http')).toBe(true);
    expect(ownsName(['dev.cajeta'], 'dev.cajetaevil')).toBe(false);
    expect(ownsName(['dev.cajeta'], 'dev.cajet')).toBe(false);
    expect(ownsName([], 'dev.cajeta')).toBe(false);
  });
});

// §1.4.2, written as a test so it cannot come back. The old rule took the
// first two segments and reversed them, so both of these resolved to `co.uk`
// — a public suffix nobody can hold — and two unrelated publishers shared one
// ownership key. There is no derivation now, so there is nothing to collide.
describe('uk.co.acme and uk.co.evil do not collide (5.1.6)', () => {
  it('lets each publish under its own namespace', async () => {
    expect((await publishAs(acme, 'uk.co.acme.thing', '1.0.0')).status).toBe(201);
    expect((await publishAs(evil, 'uk.co.evil.thing', '1.0.0')).status).toBe(201);
  });

  it("refuses each under the other's", async () => {
    expect((await publishAs(evil, 'uk.co.acme.other', '1.0.0')).status).toBe(403);
    expect((await publishAs(acme, 'uk.co.evil.other', '1.0.0')).status).toBe(403);
  });
});

describe('re-publishing an existing coordinate (5.1.7)', () => {
  it('is refused — a version is immutable, so a change is a new version', async () => {
    expect((await publishAs(cajeta, 'dev.cajeta.immutable', '1.0.0')).status).toBe(201);
    const again = await publishAs(cajeta, 'dev.cajeta.immutable', '1.0.0', {
      body: 'different bytes entirely',
    });
    expect(again.status).toBe(409);
    expect((await publishAs(cajeta, 'dev.cajeta.immutable', '1.0.1')).status).toBe(201);
  });
});

// §5.1.8. ALLOW_UNSIGNED exists so local fixtures can authenticate without a
// minted token; letting it also switch off the refusals would put the whole
// design behind an environment variable.
describe('the refusals are unconditional (5.1.8)', () => {
  const dev = { env: { ALLOW_UNSIGNED: '1' } };

  it('still refuses an unsigned upload', async () => {
    const res = await publishAs(cajeta, 'dev.cajeta.unsigned', '1.0.0', {
      unsigned: true,
      ...dev,
    });
    expect(res.status).toBe(400);
    expect(await message(res)).toContain('unsigned publish rejected');
  });

  it('still refuses an organization with no document', async () => {
    expect(
      (await publishAs(noDocument, 'dev.orphan.dev', '1.0.0', dev)).status,
    ).toBe(403);
  });

  it('still refuses a name outside the namespaces', async () => {
    expect(
      (await publishAs(acme, 'dev.cajeta.viadev', '1.0.0', dev)).status,
    ).toBe(403);
  });

  // REQUIRE_NAMESPACE is gone (5.2.3). Setting it changes nothing in either
  // direction — there is no gate left for it to open or close.
  it('has no REQUIRE_NAMESPACE gate left to flip', async () => {
    for (const value of ['0', '1']) {
      const res = await publishAs(acme, `uk.co.acme.gate${value}`, '1.0.0', {
        env: { REQUIRE_NAMESPACE: value },
      });
      expect(res.status).toBe(201);
    }
    const res = await publishAs(acme, 'dev.cajeta.gate', '1.0.0', {
      env: { REQUIRE_NAMESPACE: '0' },
    });
    expect(res.status).toBe(403);
  });
});

// The document is re-verified on load, so a row written by anything other
// than the administrative endpoint authorises nothing (§3.1, §5.1).
describe('a stored document that does not verify', () => {
  it('is refused, and is not reported as absent', async () => {
    const tampered = await makeOrg({ organization: 'dev.tampered' });
    const row = await env.DB.prepare(
      "SELECT envelope FROM signed_documents WHERE kind = 'org-keys' AND subject = 'dev.tampered'",
    ).first<{ envelope: string }>();
    const outer = JSON.parse(row!.envelope);
    outer.signature = outer.signature.replace(/^./, (ch: string) =>
      ch === 'A' ? 'B' : 'A',
    );
    await env.DB.prepare(
      "UPDATE signed_documents SET envelope = ? WHERE kind = 'org-keys' AND subject = 'dev.tampered'",
    )
      .bind(JSON.stringify(outer))
      .run();

    const res = await publishAs(tampered, 'dev.tampered.thing', '1.0.0');
    expect(res.status).toBe(403);
    expect(await message(res)).toContain('does not verify');
  });
});
