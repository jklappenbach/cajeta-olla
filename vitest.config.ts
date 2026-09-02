// Tests run inside workerd with a real D1, not a mock. Two clauses need it:
// the audit log's append-only guarantee is a SQLite trigger, and the
// admin/publish credential separation is a question about which TABLE a
// token is found in. A hand-rolled D1 double would assert neither.
import path from 'node:path';
import {
  cloudflareTest,
  readD1Migrations,
} from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const migrations = await readD1Migrations(
  path.join(import.meta.dirname, 'migrations'),
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      singleWorker: true,
      // Bindings are declared here rather than read from wrangler.toml on
      // purpose: the [assets] binding needs a built ui/dist, and a test run
      // must not depend on a front-end build.
      miniflare: {
        compatibilityDate: '2025-07-18',
        d1Databases: ['DB'],
        r2Buckets: ['BLOBS'],
        bindings: {
          TEST_MIGRATIONS: migrations,
          ALLOW_UNSIGNED: '0',
        },
      },
    }),
  ],
  test: {
    setupFiles: ['./test/setup/apply-migrations.ts'],
  },
});
