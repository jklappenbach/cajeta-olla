// GET /.well-known/cajeta-capabilities.json (§9).
import { Hono } from 'hono';
import type { Env } from '../types';
import { capabilityDoc } from '../lib/capability';

export const capabilities = new Hono<{ Bindings: Env }>();

capabilities.get('/.well-known/cajeta-capabilities.json', (c) => {
  const doc = capabilityDoc(c.env);
  // This is a discovery doc, not a /v2 response — it deliberately does NOT
  // carry the Cajeta-Capability-Version header (that's stamped on /v2/* only).
  return c.json(doc, 200, {
    'Cache-Control': `public, max-age=${doc['ttl-seconds']}`,
  });
});
