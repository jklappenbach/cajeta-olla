// Seed the local registry with a few packages by POSTing to /v2/publish.
// Run AFTER `npm run dev` (wrangler dev) is up and migrations are applied:
//   npm run migrate:local && npm run dev   # in one terminal
//   node scripts/seed.mjs                  # in another
//
// BASE overrides the target (default http://localhost:8787).
import { createHash } from 'node:crypto';

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

  const res = await fetch(`${BASE}/v2/publish`, { method: 'POST', body: form });
  const text = await res.text();
  console.log(`publish ${name}@${version} -> ${res.status} ${text}`);
  if (res.status !== 201 && res.status !== 409) {
    throw new Error(`publish failed for ${name}@${version}`);
  }
}

const packages = [
  {
    name: 'cajeta.lang.stdlib',
    version: '1.0.0',
    description: 'The Cajeta standard library — core types, collections, streams.',
    keywords: ['stdlib', 'core', 'collections', 'streams'],
  },
  {
    name: 'cajeta.io.net.http',
    version: '1.2.0',
    description: 'HTTP/1.1 + TLS client and server for Cajeta.',
    keywords: ['http', 'net', 'tls', 'client', 'server'],
    deps: { 'cajeta.lang.stdlib': '>=1.0.0' },
  },
  {
    name: 'cajeta.io.net.http',
    version: '1.2.3',
    description: 'HTTP/1.1 + TLS client and server for Cajeta.',
    keywords: ['http', 'net', 'tls', 'client', 'server'],
    deps: { 'cajeta.lang.stdlib': '>=1.0.0' },
  },
  {
    name: 'cajeta.codec.json',
    version: '0.4.0',
    description: 'Streaming JSON encoder/decoder for Cajeta.',
    keywords: ['json', 'codec', 'serialization'],
    deps: { 'cajeta.lang.stdlib': '>=1.0.0' },
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
