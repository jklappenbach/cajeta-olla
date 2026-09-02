import type { D1Migration } from '@cloudflare/vitest-pool-workers';
import type { Env as OllaEnv } from '../src/types';

// `env` from 'cloudflare:test' is typed as the global Cloudflare.Env, which
// wrangler would normally generate. This repo declares its own Env in
// src/types.ts, so point the test one at it — otherwise every `env.DB` in a
// test is an error and the tests are effectively untyped.
//
// ASSETS is declared because Env declares it, but the test worker binds no
// static assets (see vitest.config.ts): a test that actually touches it fails
// at runtime. Nothing under test does.
declare global {
  namespace Cloudflare {
    interface Env extends OllaEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}

export {};
