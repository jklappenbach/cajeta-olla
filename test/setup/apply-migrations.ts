import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll } from 'vitest';

// Every test file gets the schema the deployed database has, built by the same
// migrations wrangler applies. Storage is isolated per test, so this runs once
// per file against that file's stack.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
