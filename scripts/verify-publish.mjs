// End-to-end PROD pipeline check: register key -> signed publish -> resolve ->
// blob download (digest verified) -> retract. Proves a signed (ALLOW_UNSIGNED=0)
// registry works without seeding real package names.
//
// Needs a publish bearer token (mint one into publish_tokens, see the runbook):
//   OLLA_TOKEN=<token> BASE=https://cajeta-olla.cajeta.workers.dev \
//     node scripts/verify-publish.mjs
//
// Doubles as the template for publishing REAL packages: swap the keypair for
// your persisted publisher key and the test spec for the real archive bytes.
import { generateKeyPairSync, sign as edSign, createHash } from 'node:crypto';

const BASE = (process.env.BASE ?? 'https://cajeta-olla.cajeta.workers.dev').replace(/\/$/, '');
const TOKEN = process.env.OLLA_TOKEN;
if (!TOKEN) {
  console.error('Set OLLA_TOKEN to a valid publish bearer token. See the runbook.');
  process.exit(2);
}
const authH = { Authorization: `Bearer ${TOKEN}` };

const NAME = 'smoke.olla.test';
const VERSION = '0.0.1';
const KEY_ID = 'smoke-verify-key';

const hexDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (bytes) => 'sha256:' + hexDigest(bytes);

function ok(label, res, body) {
  const good = res.ok || res.status === 409; // 409 = already there (idempotent re-run)
  console.log(`${good ? 'OK ' : 'ERR'}  ${label} -> ${res.status} ${body}`);
  if (!good) throw new Error(`${label} failed`);
  return good;
}

// 1. Generate an ephemeral Ed25519 publisher keypair and register the public key.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

let res = await fetch(`${BASE}/v2/keys`, {
  method: 'POST',
  headers: { ...authH, 'content-type': 'application/json' },
  body: JSON.stringify({ 'key-id': KEY_ID, 'public-key': pubPem }),
});
ok('register key', res, await res.text());

// 2. Build a disposable archive, sign the RAW bytes (detached Ed25519, 64 bytes).
const bytes = new TextEncoder().encode(`CAJETA-SMOKE\n${NAME}\n${VERSION}\n`);
const sha = canonical(bytes);
const sig = edSign(null, bytes, privateKey); // Buffer, 64 raw bytes
const manifest = {
  details: { name: NAME, version: VERSION, description: 'Olla prod smoke test', 'cajeta-lang-version': '1.0' },
  settings: { description: 'Olla prod smoke test', keywords: ['smoke', 'test'] },
};

const form = new FormData();
form.set('archive', new Blob([bytes], { type: 'application/octet-stream' }), `${NAME}-${VERSION}.cja`);
form.set('metadata', JSON.stringify({ name: NAME, version: VERSION, sha256: sha }));
form.set('manifest', JSON.stringify(manifest));
form.set('readme', 'Disposable smoke-test package; retracted automatically.');
form.set('signature', new Blob([sig], { type: 'application/octet-stream' }), `${NAME}-${VERSION}.cja.sig`);
form.set('key-id', KEY_ID);

res = await fetch(`${BASE}/v2/publish`, { method: 'POST', headers: authH, body: form });
ok('signed publish', res, await res.text());

// 3. Read it back the way the build tool does.
res = await fetch(`${BASE}/${NAME}/versions.json`);
ok('versions.json', res, await res.text());

res = await fetch(`${BASE}/v2/resolve?name=${encodeURIComponent(NAME)}&version=${encodeURIComponent(VERSION)}`);
const resolveBody = await res.text();
ok('resolve', res, resolveBody);

// 4. Download the blob and verify the digest round-trips. Try canonical then hex.
let blobRes;
for (const ref of [sha, hexDigest(bytes)]) {
  blobRes = await fetch(`${BASE}/v2/blob/${encodeURIComponent(ref)}`);
  if (blobRes.ok) { console.log(`OK   blob ref form: ${ref}`); break; }
}
if (!blobRes || !blobRes.ok) throw new Error(`blob fetch failed (${blobRes && blobRes.status})`);
const got = new Uint8Array(await blobRes.arrayBuffer());
const gotSha = hexDigest(got);
if (gotSha !== hexDigest(bytes)) throw new Error(`digest mismatch: ${gotSha}`);
console.log(`OK   blob digest verified (${gotSha})`);

// 5. Retract the disposable package so it leaves search/resolve.
res = await fetch(`${BASE}/v2/retract`, {
  method: 'POST',
  headers: { ...authH, 'content-type': 'application/json' },
  body: JSON.stringify({ name: NAME, version: VERSION, reason: 'smoke test cleanup' }),
});
ok('retract', res, await res.text());

console.log('\nPIPELINE OK — signed publish, resolve, digest-verified download, retract all worked.');
