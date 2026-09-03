// Conformance — the contract's §8.1 surface, checked over real HTTP against
// a running olla (plan 7.1.1).
//
// The unit suite calls route handlers directly, so it cannot see the router,
// the capability middleware, header stamping, or anything else between the
// socket and the handler. That gap is exactly where a server passes its own
// tests and still fails a client, so these assertions go over the wire.
import { describe, expect, it } from 'vitest';

const BASE = process.env.OLLA_BASE!;
const NAME = process.env.OLLA_FIXTURE_NAME!;
const VERSION = process.env.OLLA_FIXTURE_VERSION!;

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON — the test says whether that matters */
  }
  return { res, text, json };
}

describe('capability advertisement (contract §2)', () => {
  it('serves the well-known document', async () => {
    const { res, json } = await get('/.well-known/cajeta-capabilities.json');
    expect(res.status).toBe(200);
    expect(json).toBeTruthy();
  });

  // §6.4 — turning this on is a separate, deliberate act, and it fails CLOSED
  // for every client at once. It must stay false until revocation is
  // re-issued on a schedule (plan 7.3.3).
  it('does NOT advertise revocation', async () => {
    const { json } = await get('/.well-known/cajeta-capabilities.json');
    expect(json.capabilities?.revocation ?? false).toBe(false);
  });

  it('stamps the capability header on /v2 responses', async () => {
    const { res } = await get(`/v2/resolve?name=${NAME}&version=${VERSION}`);
    expect(res.headers.get('cajeta-capability-version')).toBeTruthy();
  });
});

describe('the three signed documents (contract §3)', () => {
  it('serves the organization key document', async () => {
    const { res, json } = await get('/v2/org-keys/dev.cajeta');
    expect(res.status).toBe(200);
    expect(json.format).toBe(1);
    expect(typeof json.payload).toBe('string');
    expect(typeof json.signature).toBe('string');
  });

  // §2.1 — byte-identical. A document parsed and re-serialised does not
  // verify, so this asserts the payload decodes to the organization we
  // signed without the server having rewritten anything around it.
  it('serves it as signed, not re-encoded', async () => {
    const { json } = await get('/v2/org-keys/dev.cajeta');
    const payload = JSON.parse(
      Buffer.from(json.payload, 'base64').toString('utf8'),
    );
    expect(payload.organization).toBe('dev.cajeta');
    expect(payload.namespaces).toContain('dev.cajeta');
  });

  // Absence is not failure (contract §3): a repository that serves no
  // document for an organization must say so plainly, so a client can
  // degrade rather than treat it as a broken chain.
  it('404s an organization it has no document for', async () => {
    const { res } = await get('/v2/org-keys/nobody.example');
    expect(res.status).toBe(404);
  });

  it('serves or cleanly declines the delegation and revocations', async () => {
    for (const path of ['/v2/repository-keys', '/v2/revocations']) {
      const { res } = await get(path);
      expect([200, 404], `${path} answered ${res.status}`).toContain(res.status);
    }
  });
});

describe('release metadata (contract §3.6)', () => {
  it('carries the signed envelope beside the plain fields', async () => {
    const { res, json } = await get(`/v2/resolve?name=${NAME}&version=${VERSION}`);
    expect(res.status).toBe(200);
    expect(json.sha256).toBeTruthy();
    expect(json.signed?.format).toBe(1);

    const payload = JSON.parse(
      Buffer.from(json.signed.payload, 'base64').toString('utf8'),
    );
    expect(payload.name).toBe(NAME);
    expect(payload.sha256).toBe(json.sha256);
    // §4.5 — from the authenticated principal, over the wire this time.
    expect(payload.organization).toBe('dev.cajeta');
  });

  // Contract §3.7, and a server obligation no client can check: answering
  // 404 here for a coordinate whose bytes still download would silently
  // downgrade the client to the unsigned path while the install succeeds.
  it('never 404s a coordinate whose blob is still served', async () => {
    const { json } = await get(`/v2/resolve?name=${NAME}&version=${VERSION}`);
    // `/v2/blob/:sha` takes BARE hex; resolve reports the canonical
    // `sha256:<hex>`. The client strips the prefix, and a conformance suite
    // that quietly passed the canonical form through would be testing a
    // client this repository does not ship.
    const blob = await fetch(`${BASE}/v2/blob/${json.sha256.replace(/^sha256:/, '')}`);
    expect(blob.status).toBe(200);

    const again = await get(`/v2/resolve?name=${NAME}&version=${VERSION}`);
    expect(again.res.status).toBe(200);
  });
});

// §8.3's refusals, over the wire. They are covered in the unit suite, but
// only through direct handler calls — this proves they survive the router
// and the real request pipeline, which is where a middleware ordering
// mistake would hide them.
describe('upload refusals hold over HTTP (§8.3)', () => {
  async function publish(name: string, token: string | undefined) {
    const bytes = new TextEncoder().encode(`bytes for ${name}`);
    const form = new FormData();
    form.set('archive', new Blob([bytes]), `${name}.cja`);
    form.set('metadata', JSON.stringify({ name, version: '9.9.9' }));
    return fetch(`${BASE}/v2/publish`, {
      method: 'POST',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
  }

  it('refuses an unsigned upload', async () => {
    const res = await publish('dev.cajeta.unsigned', process.env.OLLA_ORG_TOKEN);
    expect(res.status).toBe(400);
  });

  it('refuses a name outside the signed namespaces', async () => {
    const res = await publish('evil.example.thing', process.env.OLLA_ORG_TOKEN);
    expect(res.status).toBe(403);
  });

  // This harness runs with ALLOW_UNSIGNED=1 from .dev.vars, so an absent
  // token AUTHENTICATES as the synthetic dev principal — and is then refused
  // anyway, for having no key document. That is §5.1.8 demonstrated over the
  // wire in the environment where the flag is actually on: the relaxation
  // reaches authentication and stops there.
  //
  // Production sets ALLOW_UNSIGNED=0, where the same request is 401 at the
  // token check. Both are refusals; the assertion names which one this
  // environment produces rather than accepting either.
  it('refuses an unauthenticated upload even with ALLOW_UNSIGNED=1', async () => {
    const res = await publish('dev.cajeta.anon', undefined);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no signed key document');
  });
});

// §8.3 — a PUBLISH credential cannot reach any key-management endpoint.
// The contract calls this the §9.4 regression test and says it belongs in
// every olla build.
describe('credential separation holds over HTTP (§8.3)', () => {
  it('refuses an administrative upload under a publish token', async () => {
    const res = await fetch(`${BASE}/v2/admin/org-keys/dev.cajeta`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OLLA_ORG_TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('has no key-registration endpoint at all', async () => {
    const res = await fetch(`${BASE}/v2/keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OLLA_ORG_TOKEN}` },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
