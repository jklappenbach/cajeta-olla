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
| `GET /v2/search?q=&page=&hits=` | 12 | ✅ (D1 FTS5 trigram) |
| `POST /v2/publish` (multipart) | 10 | ✅ |
| `POST /v2/retract` | 10 | ✅ |
| `GET /v2/transparency-log/:sha` | 15 | ✅ (append-on-publish) |
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

## Not yet implemented (next passes)

- **Bundle `--long` / supercompress** (§14): the baseline solid-tar + zstd path
  ships; large-window long-distance matching, store-only members, trained
  dictionary, and content-defined chunking are the remaining dedup wins.
- **`lockfile-diff` snapshots** (§14): the endpoint returns the protocol's
  404→fall-back-to-`/v2/bundle`; server-side lockfile snapshotting is TODO.
- **Real signature/attestation verification + namespace proof** (§15). Today:
  bearer tokens (`publish_tokens`, hashed) with a dev bypass when
  `ALLOW_UNSIGNED=1`; integrity (sha256) and immutability (409) are enforced.
- **Algolia** search provider (§12) — D1 FTS5 trigram is the local default.
- **CI/CD + spec conformance suite** (§16), observability (§17).

## Dev notes

- `ALLOW_UNSIGNED=1` (wrangler.toml `[vars]`) relaxes signature + token checks
  for local seeding. **Set to `0` in production.**
- D1 schema: `migrations/`. Re-apply after edits with `npm run migrate:local`.
- The Worker is a pure API (no static-asset binding) so an unknown route is
  `404 JSON` — the UI is served separately.
