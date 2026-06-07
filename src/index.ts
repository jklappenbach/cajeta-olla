// Olla — Cajeta package registry Worker (§7). Mounts the v1 + /v2 routes,
// stamps the capability header on every /v2/* response, and returns 404 JSON
// for unknown routes. Pure API surface — the web UI (ui/) is served
// separately (Vite in dev, Cloudflare Pages on the same origin in prod).
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types';
import { CAPABILITY_HEADER, CAPABILITY_VERSION } from './lib/capability';

import { capabilities } from './routes/capabilities';
import { resolve } from './routes/resolve';
import { blob } from './routes/blob';
import { search } from './routes/search';
import { transparency } from './routes/transparency';
import { publish } from './routes/publish';
import { bundle } from './routes/bundle';
import { packages } from './routes/packages';
import { keys } from './routes/keys';
import { v1 } from './routes/v1';

const app = new Hono<{ Bindings: Env }>();

// The browser UI calls this origin cross-origin in dev (Vite :5173 → Worker
// :8787) and same-origin in prod; a permissive read API CORS is safe.
app.use('*', cors());

// Stamp Cajeta-Capability-Version on every /v2/* response (and not on v1
// paths or the well-known doc) — protocol §“Capability advertisement”.
app.use('/v2/*', async (c, next) => {
  await next();
  c.header(CAPABILITY_HEADER, CAPABILITY_VERSION);
});

// Service banner.
app.get('/', (c) =>
  c.json({
    service: 'olla',
    description: 'Cajeta package registry',
    protocol: 'cajeta-repository/v1+v2',
    endpoints: [
      '/.well-known/cajeta-capabilities.json',
      '/v2/resolve',
      '/v2/blob/:sha',
      '/v2/search',
      '/v2/publish',
      '/v2/transparency-log/:sha',
      '/:pkg/versions.json',
      '/:pkg/:version/:pkg-:version.cja',
    ],
  }),
);

// v2 + well-known first (specific), v1 catch-all paths last.
app.route('/', capabilities);
app.route('/', resolve);
app.route('/', blob);
app.route('/', search);
app.route('/', transparency);
app.route('/', publish);
app.route('/', bundle);
app.route('/', packages);
app.route('/', keys);
app.route('/', v1);

app.notFound((c) => c.json({ error: 'not found' }, 404));
app.onError((err, c) => {
  console.error('olla error', err);
  return c.json({ error: 'internal error', hint: String(err) }, 500);
});

export default app;
