// Stand up a real olla and a real trust chain, once, for the whole
// conformance run.
//
// Trust is bootstrapped the way an operator does it, not stubbed: a
// development root signs an organization key document, olla is configured
// with that root's public half, and the fixture library is signed by a key
// named inside the document. Every refusal in §5 is therefore live during
// this run — a conformance suite that had to disable them would be checking
// a different server than the one that ships.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.OLLA_CONFORMANCE_PORT ?? 8791);
export const BASE = `http://127.0.0.1:${PORT}`;

let worker: ChildProcess | undefined;

async function waitForReady(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/.well-known/cajeta-capabilities.json`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`olla did not become ready at ${BASE}`);
}

export async function setup() {
  const trust = await import('../../scripts/dev-trust.mjs');

  // Before the Worker starts, so it reads the root from .dev.vars.
  trust.ensureDevRoot();

  execFileSync('npx', ['wrangler', 'd1', 'migrations', 'apply', 'olla-catalog', '--local'], {
    stdio: 'ignore',
  });

  const org = trust.installOrg({
    organization: 'dev.cajeta',
    namespaces: ['dev.cajeta'],
  });

  worker = spawn('npx', ['wrangler', 'dev', '--port', String(PORT)], {
    stdio: 'ignore',
    detached: false,
  });
  await waitForReady();

  // A fixture release, published through the real refusals.
  //
  // A fresh version per run, because the local D1 persists between runs and
  // re-publishing a coordinate is refused (§5.6) — correctly. A suite that
  // worked around that by clearing the table would be deleting the evidence
  // that immutability holds.
  const version = `1.0.${Date.now()}`;
  const name = 'dev.cajeta.conformance';
  const bytes = new TextEncoder().encode(`CAJETA-ARCHIVE\n${name}\n${version}\n`);
  const form = new FormData();
  form.set('archive', new Blob([bytes]), `${name}-${version}.cja`);
  form.set('metadata', JSON.stringify({ name, version }));
  form.set('manifest', JSON.stringify({ description: 'conformance fixture' }));
  form.set('key-id', org.keyId);
  form.set('signature', new Blob([trust.signArchive(org.privateKey, bytes)]), 'x.sig');

  const res = await fetch(`${BASE}/v2/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${org.token}` },
    body: form,
  });
  if (res.status !== 201) {
    throw new Error(`fixture publish failed: ${res.status} ${await res.text()}`);
  }

  // The client needs the development root as a trusted anchor. It goes in a
  // throwaway directory bound to CAJETA_TRUST_KEYS_DIR, never the operator's
  // own store: a development root installed system-wide would quietly widen
  // who can vouch for the public repository.
  const trustDir = mkdtempSync(join(tmpdir(), 'olla-conformance-trust-'));
  writeFileSync(
    join(trustDir, 'dev-root-1.pem'),
    createPublicKey(createPrivateKey(readFileSync('.dev-root-key.pem', 'utf8')))
      .export({ type: 'spki', format: 'pem' }) as string,
  );

  process.env.OLLA_BASE = BASE;
  process.env.OLLA_FIXTURE_NAME = name;
  process.env.OLLA_FIXTURE_VERSION = version;
  process.env.OLLA_ORG_TOKEN = org.token;
  process.env.OLLA_TRUST_DIR = trustDir;
}

export async function teardown() {
  worker?.kill('SIGTERM');
}
