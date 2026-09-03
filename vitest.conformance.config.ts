// Conformance runs in NODE against a REAL olla over HTTP, not in workerd
// against an in-process app. That is the whole point: the unit suite calls
// route handlers directly, so it cannot see anything the Worker runtime,
// the router, or the middleware does between the socket and the handler.
//
// A separate config because the two need opposite environments — the unit
// suite must be inside workerd to get a real D1, and this one must be
// outside it to hold a socket open to a running server.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/conformance/**/*.test.ts'],
    globalSetup: ['./test/conformance/boot.ts'],
    environment: 'node',
    // wrangler dev takes a few seconds to come up and the client run shells
    // out to a compiler; the default 5s is not the relevant timescale.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
