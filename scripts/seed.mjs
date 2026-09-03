// Seed the local registry with a few packages by POSTing to /v2/publish.
// Run AFTER `npm run dev` (wrangler dev) is up and migrations are applied:
//   npm run migrate:local && npm run dev   # in one terminal
//   node scripts/seed.mjs                  # in another
//
// The §5 upload refusals are unconditional, so this does what a real publisher
// does rather than leaning on a dev flag: it installs a development root, a
// signed key document per organization, and a publish key named inside it,
// then signs each archive with that key. ALLOW_UNSIGNED does not help here and
// is not meant to — an artifact nobody signed cannot be bound to a publisher.
//
// BASE overrides the target (default http://localhost:8787).
import { createHash } from 'node:crypto';
import { ensureDevRoot, installOrg, signArchive } from './dev-trust.mjs';

if (ensureDevRoot()) {
  console.error(
    '\n.dev.vars now names a development root. Restart `npm run dev`, then ' +
      're-run this script.',
  );
  process.exit(1);
}

// One organization per namespace we seed under. Namespaces are the SIGNED
// list; nothing derives them from the package names below.
const orgs = {
  'dev.cajeta': installOrg({ organization: 'dev.cajeta', namespaces: ['dev.cajeta'] }),
  'com.acme': installOrg({ organization: 'com.acme', namespaces: ['com.acme'] }),
};

function orgFor(name) {
  const org = Object.values(orgs).find(
    (o) => name === o.organization || name.startsWith(`${o.organization}.`),
  );
  if (!org) throw new Error(`no seeded organization owns '${name}'`);
  return org;
}

const BASE = process.env.BASE ?? 'http://localhost:8787';

// A .cja is an opaque archive to the registry (content-addressed bytes); for
// seeding we use deterministic placeholder payloads so digests are stable.
function fakeCja(name, version) {
  return new TextEncoder().encode(`CAJETA-ARCHIVE\n${name}\n${version}\n`);
}

function sha256Canonical(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

// Build a complete manifest (the manifest.json sidecar must validate as a full
// manifest — `details` + `settings` — for the build tool's transitive walker).
function manifestFor({ name, version, description, keywords, deps }) {
  return {
    details: {
      name,
      version,
      description,
      'cajeta-lang-version': '1.0',
    },
    settings: {
      description,
      keywords,
      ...(deps ? { dependencies: deps } : {}),
    },
  };
}

async function publish(spec) {
  const { name, version } = spec;
  const org = orgFor(name);
  const manifest = manifestFor(spec);
  const bytes = fakeCja(name, version);
  const sha = sha256Canonical(bytes);
  const form = new FormData();
  form.set(
    'archive',
    new Blob([bytes], { type: 'application/octet-stream' }),
    `${name}-${version}.cja`,
  );
  form.set('metadata', JSON.stringify({ name, version, sha256: sha }));
  form.set('manifest', JSON.stringify(manifest));
  form.set('readme', spec.description);
  form.set('key-id', org.keyId);
  form.set(
    'signature',
    new Blob([signArchive(org.privateKey, bytes)]),
    `${name}.sig`,
  );

  const res = await fetch(`${BASE}/v2/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${org.token}` },
    body: form,
  });
  const text = await res.text();
  console.log(`publish ${name}@${version} -> ${res.status} ${text}`);
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`publish failed for ${name}@${version}`);
  }
}

// NOTE: cajeta.lang.stdlib is intentionally absent — the stdlib is embedded in
// executable .cja/binaries, never a separately-distributed registry package.
const packages = [
  {
    name: 'dev.cajeta.http',
    version: '1.2.0',
    description: 'HTTP/1.1 + TLS client and server for Cajeta.',
    keywords: ['http', 'net', 'tls', 'client', 'server'],
  },
  {
    name: 'dev.cajeta.http',
    version: '1.2.3',
    description: 'HTTP/1.1 + TLS client and server for Cajeta.',
    keywords: ['http', 'net', 'tls', 'client', 'server'],
  },
  {
    name: 'dev.cajeta.codec',
    version: '0.4.0',
    description: 'Streaming JSON encoder/decoder for Cajeta.',
    keywords: ['json', 'codec', 'serialization'],
  },
  // Non-stdlib packages (the resolver drops `cajeta.*` deps as toolchain-
  // embedded, so the build-tool integration demo uses these). widgets → core.
  {
    name: 'com.acme.core',
    version: '1.0.0',
    description: 'Acme core utilities (demo dependency).',
    keywords: ['acme', 'core', 'demo'],
  },
  {
    name: 'com.acme.widgets',
    version: '1.0.0',
    description: 'Acme widgets (demo) — depends on com.acme.core.',
    keywords: ['acme', 'widgets', 'demo'],
    deps: { 'com.acme.core': '>=1.0.0' },
  },
];

for (const p of packages) await publish(p);
console.log('\nseed complete. Try:');
console.log(`  curl -s ${BASE}/com.acme.widgets/versions.json`);
console.log(`  curl -s '${BASE}/v2/resolve?name=com.acme.widgets&version=1.0.0'`);
console.log(`  curl -s '${BASE}/v2/search?q=http'`);
