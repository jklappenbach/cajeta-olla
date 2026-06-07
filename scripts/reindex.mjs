// Rebuild the Algolia search index from D1 (§12) by hitting the Worker's
// /v2/reindex endpoint (the Worker has both the D1 binding and the Algolia
// credentials). With Algolia configured this pushes every package; with the
// default D1 provider it's a no-op (indexed: -1).
//
//   node scripts/reindex.mjs            # against http://localhost:8787
//   BASE=https://olla.cajeta.dev TOKEN=… node scripts/reindex.mjs
const BASE = process.env.BASE ?? 'http://localhost:8787';
const TOKEN = process.env.TOKEN;

const res = await fetch(`${BASE}/v2/reindex`, {
  method: 'POST',
  headers: TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {},
});
const body = await res.json();
console.log(`reindex -> ${res.status}`, body);
if (body.indexed === -1) {
  console.log('(Algolia not configured — D1 FTS needs no rebuild)');
} else {
  console.log(`indexed ${body.indexed} packages into Algolia`);
}
process.exit(res.ok ? 0 : 1);
