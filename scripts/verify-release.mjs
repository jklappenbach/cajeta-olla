// Read-only production check of one release's trust chain, from the root public key in
// wrangler.toml to the archive bytes. Registers no key and publishes nothing.
//   node scripts/verify-release.mjs [name] [version]     (default dev.cajeta.cloud 0.3.2)
//   BASE=https://olla.cajeta.dev to point elsewhere.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';

const BASE = (process.env.BASE ?? 'https://olla.cajeta.dev').replace(/\/$/, '');
const NAME = process.argv[2] ?? 'dev.cajeta.cloud';
const VERSION = process.argv[3] ?? '0.3.2';

let failed = false;
function check(label, good, detail = '') {
  console.log(`${good ? 'OK ' : 'ERR'}  ${label}${detail ? ` (${detail})` : ''}`);
  if (!good) failed = true;
  return good;
}

/** Fetch `path` from BASE, failing the run on a non-2xx status. */
async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status} ${await res.text()}`);
  return res;
}

/** Verify an envelope against one PEM; returns its parsed payload, or null. */
function openEnvelope(envelope, pem) {
  const payload = Buffer.from(envelope.payload, 'base64');
  const good = verify(null, payload, createPublicKey(pem), Buffer.from(envelope.signature, 'base64'));
  return good ? JSON.parse(payload.toString('utf8')) : null;
}

/** The key with `id` in a document payload, if it is inside its window now. */
function keyNow(payload, id) {
  const k = (payload.keys ?? []).find((x) => x.id === id);
  const now = Date.now();
  return k && Date.parse(k['not-before']) <= now && now < Date.parse(k['not-after']) ? k : null;
}

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const rootPem = toml.match(/CAJETA_ROOT_KEY_PEM = """\n([\s\S]*?)"""/)?.[1];
const rootId = toml.match(/CAJETA_ROOT_KEY_ID = "([^"]+)"/)?.[1];
if (!rootPem || !rootId) throw new Error('no CAJETA_ROOT_KEY_PEM / _ID in wrangler.toml');

const release = await (await get(`/v2/resolve?name=${encodeURIComponent(NAME)}&version=${encodeURIComponent(VERSION)}`)).json();
const delegation = await (await get('/v2/repository-keys')).json();

check(`delegation signed by root '${rootId}'`, delegation['root-key-id'] === rootId);
const del = openEnvelope(delegation, rootPem);
check('delegation signature verifies against the root', !!del);
check('delegation origin is BASE', del?.repository === new URL(BASE).origin, del?.repository);

const signed = release.signed;
check('release carries signed metadata', !!signed);
const relKey = del && signed && keyNow(del, signed['root-key-id']);
check(`release key '${signed?.['root-key-id']}' is in the delegation and current`, !!relKey);
const meta = relKey && openEnvelope(signed, relKey['public-key']);
check('release metadata verifies against the delegated key', !!meta);
check('signed name and version match', meta?.name === NAME && meta?.version === VERSION);
check('signed sha256 matches the resolve body', meta?.sha256 === release.sha256, meta?.sha256);

const org = meta?.organization;
const orgEnv = org && (await (await get(`/v2/org-keys/${encodeURIComponent(org)}`)).json());
const orgDoc = orgEnv && openEnvelope(orgEnv, rootPem);
check(`organization document for '${org}' verifies against the root`, !!orgDoc);
check(`'${org}' owns '${NAME}' in its signed namespaces`,
  !!orgDoc?.namespaces?.some((ns) => NAME === ns || NAME.startsWith(`${ns}.`)));

const base = `/${NAME}/${VERSION}/${NAME}-${VERSION}.cja`;
const archive = Buffer.from(await (await get(base)).arrayBuffer());
const digest = 'sha256:' + createHash('sha256').update(archive).digest('hex');
check('archive digest matches the signed sha256', digest === meta?.sha256, digest);

const keyId = (await (await get(`${base}.sig.keyid`)).text()).trim();
const sig = Buffer.from(await (await get(`${base}.sig`)).arrayBuffer());
const orgKey = orgDoc && keyNow(orgDoc, keyId);
check(`archive key '${keyId}' is in '${org}' document and current`, !!orgKey);
check('archive signature verifies against the organization key',
  !!orgKey && verify(null, archive, createPublicKey(orgKey['public-key']), sig));

console.log(failed ? `\nFAILED — ${NAME}@${VERSION}` : `\nVERIFIED — ${NAME}@${VERSION} published by ${org}, signed with ${keyId}`);
process.exit(failed ? 1 : 0);
