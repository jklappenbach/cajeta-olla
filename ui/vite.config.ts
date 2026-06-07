import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev: proxy the registry API to the local Worker (wrangler dev on :8787) so
// the UI calls the same paths it will in production (same origin via Pages).
const API = process.env.OLLA_API ?? 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/v2': API,
      '/.well-known': API,
      // v1 version index lives at /:pkg/versions.json — proxy by pattern.
      '^/[^/]+/versions\\.json$': API,
    },
  },
});
