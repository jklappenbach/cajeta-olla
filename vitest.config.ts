// Tests run inside workerd with a real D1, not a mock. Two clauses need it:
// the audit log's append-only guarantee is a SQLite trigger, and the
// admin/publish credential separation is a question about which TABLE a
// token is found in. A hand-rolled D1 double would assert neither.
import { generateKeyPairSync } from 'node:crypto';
import path from 'node:path';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, 'migrations'),
);

// A throwaway root keypair, minted per run. Tests need to SIGN documents to
// check that verification accepts them, and the production root's private half
// is offline and encrypted — as it must stay. The public half is bound as the
// worker's trusted root; the private half is bound for tests to sign with and
// exists nowhere else.
//
// The real ceremony output is still exercised: test/fixtures holds the actual
// signed delegation and the real olla-root.pub, and the test that verifies
// them passes that root explicitly.
const testRoot = generateKeyPairSync('ed25519');

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      // The real worker entrypoint, so route tests go through Hono and the
      // actual middleware via SELF.fetch() rather than a hand-assembled app.
      main: './src/index.ts',
      // Bindings are declared here rather than read from wrangler.toml on
      // purpose: the [assets] binding needs a built ui/dist, and a test run
      // must not depend on a front-end build.
      miniflare: {
        compatibilityDate: '2025-07-18',
        modulesRules: [{ type: 'CompiledWasm', include: ['**/*.wasm'] }],
        d1Databases: ['DB'],
        r2Buckets: ['BLOBS'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          ALLOW_UNSIGNED: '0',
          CAJETA_ROOT_KEY_ID: 'test-root-1',
          CAJETA_ROOT_KEY_PEM: testRoot.publicKey.export({
            type: 'spki',
            format: 'pem',
          }) as string,
          TEST_ROOT_KEY_PEM: testRoot.privateKey.export({
            type: 'pkcs8',
            format: 'pem',
          }) as string,
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup/apply-migrations.ts'],
    // test/conformance runs in NODE against a running server
    // (vitest.conformance.config.ts). It cannot run inside workerd, so it is
    // excluded here rather than left to fail confusingly.
    exclude: ['**/node_modules/**', 'test/conformance/**'],
  },
});
