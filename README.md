# Olla

**Olla** — the package registry for the [Cajeta](https://github.com/jklappenbach/cajeta)
programming language (`olla.cajeta.dev`).

A single Cloudflare **Worker** (Hono, TypeScript) serves the v1 + `/v2` wire
protocol the Cajeta build tool speaks; **R2** holds content-addressed artifact
bytes and **D1** holds the catalog. A static **React** UI (in `ui/`) calls the
same origin. Everything runs locally with no Cloudflare account — `wrangler
dev` emulates R2 + D1 on disk.

Architecture & rationale: [`plans/olla-infrastructure-plan.md`](plans/olla-infrastructure-plan.md).
Wire contract: `cajeta-docs/specs/repository-protocol-v1.md` (in the `cajeta`
repo) — the authoritative shape is the C++ client at
`src/cajeta/buildtool/repo/HttpRepository.cpp`.

## Boundaries

- **This repo** holds the registry *service*: the v1 + `/v2` API, the web app,
  and infrastructure (Cloudflare Workers + R2 + D1, Algolia search index).
- **The wire spec is canonical in `cajeta`**, not here (`cajeta-docs/specs/`).
  Olla *consumes* the spec; the build-tool **client** also lives in `cajeta`.
- **The marketing site** (`cajeta.dev`, incl. the `/repo` page) lives in the
  `cajeta` repo under `site/`.

## Run it locally

Two processes: the **registry API** (the part the build tool talks to) and the
**web UI**.

### 1. Registry API (Worker)

```sh
npm install
npm run migrate:local     # apply D1 migrations to the local emulated DB
npm run dev               # wrangler dev → http://localhost:8787
```

Seed a few packages (second terminal, with `dev` running):

```sh
node scripts/seed.mjs
```

Smoke-test the download path the build tool uses:

```sh
curl -s http://localhost:8787/.well-known/cajeta-capabilities.json
curl -s http://localhost:8787/cajeta.io.net.http/versions.json
curl -s 'http://localhost:8787/v2/resolve?name=cajeta.io.net.http&version=>=1.2.0'
curl -s http://localhost:8787/v2/blob/<sha-from-resolve> | sha256sum   # == the digest
curl -s 'http://localhost:8787/v2/search?q=http'
```

### 2. Web UI (React)

```sh
cd ui
npm install
npm run dev               # vite → http://localhost:5173  (proxies the API)
```

The UI flow: **search (empty state) → results → result detail → copy link**,
plus a **Browse** page over the whole catalog (library APIs).

## Point the Cajeta build tool at it

Add an HTTP repository to a project's `cajeta.json`:

```json
{
  "settings": {
    "repositories": [
      { "name": "local-olla", "type": "http", "url": "http://localhost:8787" }
    ]
  }
}
```

`cajeta build` then resolves declared dependencies against Olla and downloads
artifacts (`/v2/resolve` → `/v2/blob`, or the v1 artifact path).

## Endpoints

| Route | § | Status |
|-------|---|--------|
| `GET /.well-known/cajeta-capabilities.json` | 9 | ✅ |
| `GET /:pkg/versions.json` | 11 | ✅ |
| `GET /:pkg/:version/:pkg-:version.cja` (+ `.sig`, `.sig.keyid`) | 13 | ✅ |
| `GET /:pkg/:version/manifest.json` | 11 | ✅ |
| `GET /v2/resolve?name=&version=` | 11 | ✅ |
| `GET /v2/blob/:sha` (ETag, Range, 304) | 13 | ✅ |
| `GET /v2/search?q=&page=&hits=` | 12 | ✅ (D1 FTS5 trigram, or Algolia) |
| `POST /v2/reindex` (rebuild Algolia from D1) | 12 | ✅ |
| `POST /v2/publish` (Ed25519 sig + attestation verified) | 10/15 | ✅ |
| `GET /:pkg/:ver/:pkg-:ver.cja.attestation` | 15 | ✅ |
| `POST /v2/retract` | 10 | ✅ |
| `POST /v2/keys` (register trusted Ed25519 key) | 15 | ✅ |
| `POST /v2/namespaces/verify` (DNS-TXT / github) | 15 | ✅ |
| `GET /v2/transparency-log/:sha` (registry-signed entries) | 15 | ✅ |
| `GET /v2/packages`, `/v2/package/:name` | — | ✅ (UI read surface) |
| `POST /v2/bundle` (tar.zst, `have`/`want`/`transitive`) | 14 | ✅ (`capabilities.bundle=true`) |
| `POST /v2/lockfile-diff` | 14 | ⏳ 404→fall-back-to-bundle (no snapshots yet) |

## Verify against the real build tool

`examples/olla-demo/` is a project that declares `com.acme.widgets` and points
at the local Olla. With `npm run dev` up and the registry seeded:

```sh
cd examples/olla-demo
cajeta info --resolve-time      # resolves widgets + transitively com.acme.core
```

The build tool fetches `/:pkg/versions.json` → `/:pkg/:ver/…cja` →
`/:pkg/:ver/manifest.json` (transitive expansion) and caches the downloaded
`.cja`s under `.cajeta/cache/` — content-addressed by the same digests Olla
published. (`cajeta.*` deps are skipped — the toolchain embeds the stdlib — so
the demo uses a `com.acme.*` namespace.)

The `/v2/bundle` codec is byte-compatible with the client's
`TarZstd.cpp` (POSIX ustar, zstd level 3, `<sha256-hex>.cja` members +
`bundle.json`); verify with `zstd -dc bundle.tzst | tar -t`.

## Signing & trust (§15)

Publish verifies a **detached Ed25519 signature over the raw `.cja` bytes**
against a trusted public key (Web Crypto `Ed25519` — byte-compatible with the
build tool's OpenSSL `EVP_PKEY_ED25519` / `SignAction.cpp`):

```sh
# register a publisher's PEM public key
curl -X POST $BASE/v2/keys -d '{"key-id":"acme-key-1","public-key":"-----BEGIN PUBLIC KEY-----…"}'
# publish with the detached 64-byte sig + key-id (multipart fields signature, key-id)
```

A valid signature → 201; a tampered one → 400; an untrusted `key-id` → 403
(unless `ALLOW_UNSIGNED=1`, the local dev bypass). Each publish also appends a
transparency-log entry **signed by the registry's own Ed25519 log key**
(`LOG_SIGNING_KEY_PEM` / `LOG_SIGNING_KEY_ID`), served at
`/v2/transparency-log/:sha`. Namespace ownership (DNS-TXT `_cajeta-publish.<domain>`
or `.github/cajeta-publish.txt`) is verified via `/v2/namespaces/verify` and
enforced on publish when `REQUIRE_NAMESPACE=1`.

**Attestation (provenance).** When a publish carries an `attestation` field, the
registry verifies the in-toto Statement v1 / SLSA provenance v1 envelope
exactly as the build tool's `verifyProvenanceJson` does — statement +
predicate + `cajeta.org/build/v1` build type, required compiler/manifest
fields, and the **subject digest bound to the published archive** (a
mis-bound or malformed attestation → 400). The verified envelope is stored and
served at the `<archive>.attestation` sidecar that `cajeta install` reads.

## Search providers (§12)

Default **D1 FTS5 trigram** (substring + typo tolerant, zero-config, kept in
sync by triggers). Set `SEARCH_PROVIDER=algolia` + `ALGOLIA_APP_ID` /
`ALGOLIA_API_KEY` (admin) / `ALGOLIA_INDEX` to use Algolia instead: publishes
push to the index, retracts drop from it, and `POST /v2/reindex`
(`scripts/reindex.mjs`) rebuilds from D1. Algolia errors degrade to D1 rather
than failing the request.

## Bundle dedup (§14)

`/v2/bundle` compresses the solid tar at level 19 (`BUNDLE_ZSTD_LEVEL`), so a
shared section dedups across members. `scripts/measure-dedup.sh` proves it
(bundle / Σ-individual ≈ 0.5, gate < 0.95).

## Not yet implemented (next passes)

- **supercompress** (§14): trained zstd dictionary + content-defined chunking,
  and `--long` windows > 27 — all need a client that opts into the larger
  window / dictionary, so `capabilities.supercompress` stays `false`.
- **Store-only `.cja` ingestion** (§14): real archives are pre-compressed, so
  cross-member matching needs store-only members — an archive-format/build-tool
  concern, surfaced here in `measure-dedup.sh`'s note.
- **`lockfile-diff` snapshots** (§14): returns the protocol's
  404→fall-back-to-`/v2/bundle`; server-side lockfile snapshotting is TODO.
- **Signed-DSSE attestations** (§15): provenance is verified structurally + by
  digest binding today; the build tool ships the envelope unsigned, so when it
  starts wrapping it in a signed DSSE envelope, verify that signature too.
- **Token minting** (§15): `publish_tokens` verification works (with the dev
  bypass); an admin mint/rotate endpoint is TODO.
- **CI/CD + spec conformance suite** (§16), observability (§17).

## Dev notes

- `ALLOW_UNSIGNED=1` (wrangler.toml `[vars]`) relaxes signature + token checks
  for local seeding. **Set to `0` in production.**
- D1 schema: `migrations/`. Re-apply after edits with `npm run migrate:local`.
- The Worker is a pure API (no static-asset binding) so an unknown route is
  `404 JSON` — the UI is served separately.
