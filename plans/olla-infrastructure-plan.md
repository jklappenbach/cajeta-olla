# Olla — Cajeta Package Registry — Operational Plan

> Status: **Plan / design.**
> Scope: everything needed to stand up **Olla** — the Cajeta package registry
> *service* (server, `/v2` API, web app) and its hosting — and make it
> **operational**: accept library **publish** POSTs, serve **search**, serve
> **single-library download**, and serve **batched (bundle) download** with
> cross-library deduplication. Served at **`olla.cajeta.dev`**.

> **Provenance.** Extracted from the Cajeta website plan
> (`cajeta/plans/cajeta-site-plan.md`, formerly §15) when Olla split into its own
> repo. The repo-boundary rationale lives in that plan's §1.1; a stub there points
> here. Cross-references to "cajeta-site-plan.md §N" mean that document. The wire
> contract this server implements is canonical in
> `cajeta/cajeta-docs/specs/repository-protocol-v1.md` (+ `capabilities-v1.json`,
> `manifest-v1.json`, `lockfile-v1.json`) — **the spec is law; Olla conforms to
> it, never the reverse.**

The Maven-Central-style package registry for Cajeta. **D1 + R2 are the system of
record; Algolia is a derived search index.** Recurring cost ≈ the domain only
until real scale (§6).

---

## How to read each section

Every section keeps its **description**, then adds **Deliverables** (what must
exist when it's done) and **Acceptance criteria** (how we confirm it). AC tags:

- **[self]** — Claude can verify directly by running the given command, no
  credentials needed. For functional checks, `$BASE` can point at a **local
  `wrangler dev`** instance (`http://127.0.0.1:8787`) *before* DNS/deploy — so
  endpoint behavior is verifiable without any cloud account.
- **[you]** — needs your Cloudflare / Namecheap / Algolia console, a secret, or
  `wrangler`/`gh` auth. Run it (or the `! <cmd>` form) and Claude checks the
  output. Many `[you]` checks become `[self]` once the relevant token is exported.
- **[x]** — already satisfied (verified during this planning pass).

Conventional shell vars used below: `BASE` (registry origin), `PKG`/`VER`
(a test package), `SHA` (a `sha256:<hex>` digest).

---

## 1. Decision: name & repo boundaries
- **Name:** the registry property is **Olla** (Spanish for the pot caramel is
  cooked in; the Ollama echo is considered an asset). Chosen over *Cazo* / *Paila*.
- **Own repository.** Olla (server + web/API) lives in **this** git repo
  (`cajeta-olla`), separate from the `cajeta` compiler repo (see
  cajeta-site-plan.md §1.1). Rationale: different stack (web/TS vs C++/LLVM), a
  live service with its own security surface and deploy cadence, independent
  protocol versioning, and the "host your own registry" goal. Published
  *artifacts* live in object storage, not git (§4).
- **Spec stays canonical in `cajeta`.** The wire contract + schemas remain in
  `cajeta/cajeta-docs/specs/`; the build-tool **client** stays in
  `cajeta/src/cajeta/buildtool/repo/`. This repo *consumes* the spec (git
  submodule or published schema/test-vector package) and runs **conformance
  tests** against it so client and server can't drift.

**Deliverables**
- [x] `cajeta-olla` repo created on GitHub (public), local clone + remote wired.
- [x] This plan extracted from cajeta-site-plan §15; stub + reciprocal links in place.
- [ ] Spec-consumption mechanism chosen & wired: **git submodule** of
  `cajeta/cajeta-docs/specs` at `./spec/` (recommended) *or* a pinned published
  schema package.
- [ ] Conformance harness skeleton (`test/conformance/`) that loads `./spec/` and
  asserts the live server's shapes against it.

**Acceptance criteria**
- [x] [self] `gh repo view jklappenbach/cajeta-olla --json visibility,name` → `PUBLIC`, `cajeta-olla`.
- [x] [self] `grep -rn "jklappenbach/olla" .` in both repos → no stale refs (only `cajeta-olla`).
- [ ] [self] `test -f spec/repository-protocol-v1.md` resolves (submodule populated) and `git submodule status` shows it pinned to a cajeta commit.
- [ ] [self] `npm run test:conformance` exits 0 against a local `wrangler dev` server.

## 2. Domain scheme (root owned: `cajeta.dev` @ Namecheap)
- **Canonical root:** **`cajeta.dev`** (registered at Namecheap).
- **Subdomains** (free under the one root):

  | Host | Serves |
  |------|--------|
  | `cajeta.dev` (apex) | marketing + docs site (`cajeta/site`) |
  | `olla.cajeta.dev` | the **Olla** registry (web app + `/v2` API) |
  | `www.cajeta.dev` | 301 → apex |
  | `docs.cajeta.dev` | optional, only if docs split from the main site |

- **DNS via Cloudflare** — Namecheap stays *registrar*; we delegate DNS (removes
  the apex-CNAME limitation, adds free TLS/CDN).
- **Spec edit (lands in `cajeta`):** swap specs' `repo.cajeta.org` →
  `olla.cajeta.dev` and the build-tool default repo URL. `.dev` is HSTS-preloaded
  → HTTPS everywhere.
- **Optional:** grab apex `olla.dev` and 301 it to `olla.cajeta.dev`.

**Deliverables**
- [ ] Subdomain map confirmed and recorded (this table is the source of truth).
- [ ] `repo.cajeta.org → olla.cajeta.dev` rename queued as a `cajeta`-repo edit (tracked in §18).
- [ ] (optional) `olla.dev` acquired + 301.

**Acceptance criteria**
- [x] [self] domain is owned/controllable: `dig +short SOA cajeta.dev` returns an SOA (registered).
- [ ] [self] after §3A: `dig +short NS cajeta.dev` returns two `*.ns.cloudflare.com`.
- [ ] [self] `dig +short olla.cajeta.dev` resolves to Cloudflare-proxied IPs.
- [ ] [self] (if taken) `curl -sI https://olla.dev` → 301 `location: https://olla.cajeta.dev/`.

## 3. Cloudflare setup — itemized steps

**A. Delegate DNS**
1. Create a free Cloudflare account.
2. **Add a site** → `cajeta.dev` → **Free** plan. Cloudflare imports existing DNS (review).
3. Cloudflare assigns **two nameservers**.
4. Namecheap → *Domain List → Manage `cajeta.dev` → Nameservers → Custom DNS* →
   paste the two Cloudflare nameservers → save.
5. Wait for the zone to read **Active**.

**B. DNS records** (Cloudflare → DNS → Records)
6. Apex: `CNAME cajeta.dev → <site-project>.pages.dev` (proxied; CNAME flattening).
7. `CNAME www → cajeta.dev` + a Redirect Rule `www → apex` (301).
8. Registry: `CNAME olla → <olla-app>.workers.dev` (or Worker custom-domain route), proxied.
9. (optional) `CNAME docs → <docs-project>.pages.dev`.

**C. TLS**
10. SSL/TLS → **Full (strict)**; enable **Always Use HTTPS**.

**D. The site app** *(lives in `cajeta`; here for the full DNS picture)*
11. Cloudflare **Pages** → connect site repo → Next.js preset (or static `out/`) → deploy.
12. Pages → **Custom domains** → add `cajeta.dev` (+ `www`).

**E. The Olla app (Workers + R2 + D1)** *(this repo — see §7–§17 for code)*
13. Scaffold the Worker (§7).
14. **R2:** `wrangler r2 bucket create olla-artifacts`; bind `[[r2_buckets]]` (§4).
15. **D1:** `wrangler d1 create olla-catalog`; bind; apply migrations + FTS5 (§8).
16. **Secrets:** `wrangler secret put …` (publish auth, trust keys, namespace config) (§15).
17. Deploy the Worker; add custom domain `olla.cajeta.dev`.
18. Smoke test (§9–§14 AC).

**F. Wire the site to Olla** *(edits land in `cajeta`)*
19. Point `/repo` client (`lib/registry.ts`) at `https://olla.cajeta.dev`.
20. Apply the `repo.cajeta.org → olla.cajeta.dev` spec/build-tool edits.

**Deliverables**
- [ ] Cloudflare account + `cajeta.dev` zone (Free); Namecheap nameservers switched; zone Active.
- [ ] DNS records: apex, www + redirect, `olla`, (optional docs).
- [ ] TLS Full (strict) + Always Use HTTPS.
- [ ] `olla.cajeta.dev` custom domain bound to the Worker, cert provisioned.

**Acceptance criteria**
- [ ] [self] `dig +short NS cajeta.dev` → two Cloudflare nameservers.
- [ ] [self] `dig +short cajeta.dev` and `dig +short olla.cajeta.dev` → Cloudflare anycast IPs.
- [ ] [self] `curl -sI https://cajeta.dev` → `200`, header `server: cloudflare`.
- [ ] [self] `curl -sI https://www.cajeta.dev` → `301`, `location: https://cajeta.dev/`.
- [ ] [self] `curl -sI https://olla.cajeta.dev/.well-known/cajeta-capabilities.json` → `200` over valid TLS.
- [ ] [self] `echo | openssl s_client -connect olla.cajeta.dev:443 -servername olla.cajeta.dev 2>/dev/null | openssl x509 -noout -issuer -dates` → valid, unexpired cert.
- [ ] [you] Cloudflare zone shows **Active** and SSL mode **Full (strict)** (dashboard; or API with `$CF_API_TOKEN`).

## 4. File storage (artifacts) → Cloudflare R2
- **R2** — S3-compatible, **zero egress** (decisive for a download-heavy
  registry), ~$0.015/GB-mo, 10 GB free, native Workers binding.
- Layout: **content-addressed** by SHA-256 (`blob/<sha256>`), with human pointer
  paths (`<pkg>/<ver>/<pkg>-<ver>.cja[.sig|.sig.keyid]`) mapping to blobs.
  Immutable versions; free dedup; matches `/v2/bundle` `have`/`want`.
- Runner-up: **Backblaze B2** (free egress to Cloudflare via Bandwidth Alliance).

**Deliverables**
- [ ] Bucket `olla-artifacts` created and bound in `wrangler.toml` (`[[r2_buckets]]`).
- [ ] Write path stores blobs at `blob/<sha256>` (canonical) + a pointer record (D1) for the human path.
- [ ] Immutability guard: republishing an existing `(name,version)` is rejected; identical bytes dedup to one blob.
- [ ] Lifecycle/retention documented (artifacts are immutable; yank flips a flag, never deletes the blob).

**Acceptance criteria**
- [ ] [self] `grep -q "\[\[r2_buckets\]\]" wrangler.toml && grep -q "olla-artifacts" wrangler.toml`.
- [ ] [self] after a test publish: `curl -s $BASE/v2/blob/$SHA | sha256sum` equals the hex in `$SHA` (content address verified).
- [ ] [self] publishing identical bytes twice does **not** grow object count: compare `wrangler r2 object get`/list counts before & after (stable).
- [ ] [self] republishing the same `(name,version)` with different bytes → HTTP `409`.
- [ ] [you] `wrangler r2 bucket list` includes `olla-artifacts` (needs wrangler auth; `[self]` if authed).

## 5. Catalog DB + search hosting → start serverless
- **System of record: Cloudflare D1** (serverless SQLite). Catalog is
  metadata-only (names, versions, digests, parsed manifest, README) — small,
  text-only. Powers `resolve`, the version index, and feeds search.
- **Upgrade path:** **Neon** serverless Postgres (FTS + `pg_trgm` over HTTP).
- **Only if a persistent box is needed:** **Oracle Cloud Always Free** / Fly.io / ~$5 Hetzner.

**Deliverables**
- [ ] `olla-catalog` D1 database created and bound (`[[d1_databases]]`).
- [ ] Migration runner (`migrations/` + `wrangler d1 migrations`) checked in.
- [ ] Schema (§8) applied: packages, versions, owners, namespaces, blobs, publish_tokens, transparency_log, FTS5.

**Acceptance criteria**
- [ ] [self] `grep -q "\[\[d1_databases\]\]" wrangler.toml && grep -q "olla-catalog" wrangler.toml`.
- [ ] [self] `wrangler d1 execute olla-catalog --local --command "SELECT name FROM sqlite_master WHERE type IN ('table','view')"` lists all §8 tables + the FTS5 table.
- [ ] [self] migrations are idempotent: re-running `wrangler d1 migrations apply olla-catalog --local` reports "No migrations to apply."
- [ ] [you] `wrangler d1 list` includes `olla-catalog` (auth needed).

### 5.1 Typo tolerance / close-match (hard requirement)
Users **will** mistype names. D1's weakest area, so don't oversell FTS5:
- ✅ FTS5 **`trigram` tokenizer** → substring/partial; needs **≥3-char** queries
  (cover 1–2-char with prefix match).
- ❌ D1 has **no `spellfix1`** → no native edit-distance "did you mean."

**Decision: Algolia** is the package search index (typo tolerance on by
default). D1 + R2 remain system of record; Algolia is a **derived index updated
on publish**, **rebuildable from D1**, behind the `lib/registry` provider
interface. Apply to **Algolia for Open Source** (200k records + 200k req/mo, free
for a "Search by Algolia" badge); **Build** free tier until approved. Escape
hatch: self-hosted **Typesense/Meilisearch** (Oracle Always Free). **$0 offline
fallback:** D1 trigram + Worker-side Levenshtein rerank if Algolia is down.
*Not Elasticsearch* (no managed CF offering, wrong weight class). *Optional later:*
**Vectorize** for semantic close-match alongside lexical.

**Deliverables**
- [ ] Algolia index `olla_packages` provisioned (Build tier), typo tolerance enabled.
- [ ] AOS program application submitted.
- [ ] D1-trigram + Levenshtein fallback path implemented behind the same interface.

**Acceptance criteria**
- [ ] [self] misspelled query returns the intended package: `curl -s "$BASE/v2/search?q=colletcions"` includes `cajeta.collection` in the top 3.
- [ ] [self] short query works: `curl -s "$BASE/v2/search?q=ca"` returns prefix matches (non-empty).
- [ ] [self] fallback path: with `SEARCH_PROVIDER=d1` set, the same typo query still returns the intended package (degraded but correct).
- [ ] [you] AOS application submitted/approved (Algolia dashboard).

## 6. Cost summary
| Item | Choice | Cost |
|------|--------|------|
| Domain | `cajeta.dev` (owned, Namecheap) | ~$12/yr |
| DNS + CDN + TLS | Cloudflare Free | $0 |
| Site hosting | Cloudflare Pages | $0 |
| Registry compute | Cloudflare Workers | $0 (free tier) |
| Artifact storage | Cloudflare R2 | $0 to start (10 GB free, no egress) |
| Catalog (system of record) | Cloudflare D1 | $0 (free tier) |
| Search index | Algolia (Open Source program) | $0 (200k records + 200k req/mo; badge) |
| **Total recurring** | | **~$12/yr (domain only)** until real scale |

**Deliverables**
- [ ] Billing alerts configured on Cloudflare (Workers/R2/D1) and Algolia.
- [ ] A short cost-watch note in `README` (which dials cost money first: R2 egress N/A, Workers requests, Algolia overage).

**Acceptance criteria**
- [ ] [self] no paid-only bindings sneak in: `grep -nE "durable_objects|hyperdrive|queues" wrangler.toml` reviewed (none unexpected).
- [ ] [you] Cloudflare + Algolia dashboards show usage within free tier; billing alerts set.

---

# Operational service (the part that makes Olla actually run)

The remaining sections implement the live service. Every endpoint below is
defined by `cajeta/cajeta-docs/specs/repository-protocol-v1.md`; section headers
cite the exact route. The four user-named flows map to: **publish** → §10,
**search** → §12, **single download** → §13, **batched/zipped download** → §14.

## 7. Service architecture & repo layout
A single Cloudflare **Worker** (Hono or itty-router) serves both the v1 paths
and the `/v2` API; the registry **web UI** is static (Pages) calling the same
origin. TypeScript, `wrangler` for dev/deploy. Layout:

```
cajeta-olla/
  src/
    index.ts            # router: mounts v1 + v2 routes, capability header middleware
    routes/
      capabilities.ts   # GET /.well-known/cajeta-capabilities.json        (§9)
      v1.ts             # GET /:pkg/:ver/<file>, GET /:pkg/  (v1 paths)     (§11,§13)
      publish.ts        # POST /v2/publish                                  (§10)
      resolve.ts        # GET /v2/resolve                                   (§11)
      search.ts         # GET /v2/search                                    (§12)
      blob.ts           # GET /v2/blob/:sha256                              (§13)
      bundle.ts         # POST /v2/bundle, POST /v2/lockfile-diff           (§14)
      transparency.ts   # GET /v2/transparency-log/:sha256                  (§15)
    lib/
      storage.ts        # R2 blob get/put, content-address                 (§4)
      catalog.ts        # D1 queries (packages/versions/owners)            (§8)
      search-index.ts   # Algolia + D1 fallback provider                   (§5.1,§12)
      bundle-codec.ts   # tar + zstd(--long)/dictionary/CDC                (§14)
      auth.ts           # bearer/mTLS, publish tokens, namespace verify     (§15)
      signature.ts      # detached-sig + attestation verify, key-id         (§15)
      capability.ts     # Cajeta-Capability-Version header, probe payload   (§9)
  migrations/           # D1 SQL migrations                                 (§8)
  spec/                 # submodule → cajeta/cajeta-docs/specs (conformance)(§1,§16)
  test/
    unit/  conformance/  load/
  wrangler.toml
  package.json  tsconfig.json
```

**Deliverables**
- [ ] Worker scaffold builds and serves locally (`wrangler dev`).
- [ ] Router mounts all routes in §9–§15; unknown route → `404` JSON.
- [ ] Middleware stamps `Cajeta-Capability-Version: 1` on every `/v2/*` response (and **not** on v1 paths).
- [ ] `wrangler.toml` declares bindings for R2 (§4), D1 (§5), and required vars/secrets.

**Acceptance criteria**
- [ ] [self] `npm run build` / `wrangler deploy --dry-run` exits 0.
- [ ] [self] `wrangler dev &` then `curl -sI $BASE/v2/resolve?name=x` carries header `cajeta-capability-version: 1`.
- [ ] [self] a v1 path response (`curl -sI $BASE/nope/1.0.0/nope-1.0.0.cja`) does **not** carry that header.
- [ ] [self] `curl -s -o /dev/null -w '%{http_code}' $BASE/totally/unknown` → `404`.

## 8. Data model & D1 migrations
Metadata-only relational core + an FTS mirror. Tables:

- `packages(name PK, namespace, description, keywords, latest_version, created_at)`
- `versions(name, version, sha256, manifest_json, readme, retracted INT, retracted_reason, key_id, published_at, PRIMARY KEY(name,version))`
- `owners(name, principal, role)` — package ACL
- `namespaces(owner, domain, method, proof, verified_at)` — DNS-TXT / github proof (§15)
- `blobs(sha256 PK, size, r2_key, created_at)` — content-address index (R2 is the bytes)
- `publish_tokens(token_hash PK, principal, scopes, created_at, expires_at)`
- `transparency_log(seq INTEGER PK AUTOINCREMENT, sha256, signed_at, log_entry_signature, log_entry_key_id)`
- `packages_fts` — FTS5(`trigram`) over `(name, description, keywords, readme)`, kept in sync by triggers on `versions`/`packages`.

**Deliverables**
- [ ] `migrations/0001_init.sql` creating all tables + indexes.
- [ ] `migrations/0002_fts.sql` creating `packages_fts` + sync triggers.
- [ ] Typed query helpers in `lib/catalog.ts` (no raw SQL in routes).

**Acceptance criteria**
- [ ] [self] fresh apply: `wrangler d1 migrations apply olla-catalog --local` → all migrations applied, exit 0.
- [ ] [self] schema present: the `SELECT … sqlite_master` check (§5 AC) lists every table above + `packages_fts`.
- [ ] [self] FTS sync: insert a version row via a seed script → `SELECT name FROM packages_fts WHERE packages_fts MATCH 'trigram-of-name'` returns it.
- [ ] [self] retraction is non-destructive: setting `retracted=1` leaves the `blobs`/`versions` row intact (row count unchanged).

## 9. Capability probe & discovery (`GET /.well-known/cajeta-capabilities.json`)
A v2-capable registry serves the capability document (per spec): `capabilities`
(`v1, v2, bundle, lockfile-diff, supercompress, transparency-log,
well-known-bundles[]`), optional `mirrors[]`, `ttl-seconds`. Clients cache for
the TTL; every `/v2/*` response also carries `Cajeta-Capability-Version: 1`.
v1-only clients never request it and keep using v1 paths.

**Deliverables**
- [ ] `GET /.well-known/cajeta-capabilities.json` returns the document with the flags Olla actually implements (`v1/v2/bundle/lockfile-diff/transparency-log: true`; `supercompress` per §14 rollout; `well-known-bundles` from config).
- [ ] `ttl-seconds` and (optional) `mirrors` configurable via vars.
- [ ] Response validates against `spec/capabilities-v1.json`.

**Acceptance criteria**
- [ ] [self] `curl -s $BASE/.well-known/cajeta-capabilities.json | jq -e '.capabilities.v2 == true and .capabilities.bundle == true'`.
- [ ] [self] document validates: `npx ajv validate -s spec/capabilities-v1.json -d <(curl -s $BASE/.well-known/cajeta-capabilities.json)` → valid.
- [ ] [self] advertised flags match reality — `supercompress:true` **iff** §14's supercompress path is deployed (conformance test asserts the implication).
- [ ] [self] `curl -sI $BASE/v2/resolve?name=x | grep -i cajeta-capability-version` → `1`.

## 10. Publish — `POST /v2/publish`  ← accept library publish POSTs
Multipart form (per spec): `archive` (the `.cja`), `signature` (detached `.sig`,
when signed), `key-id`, `attestation` (when produced), `metadata` (JSON: `name`,
`version`, `sha256`). Server pipeline:
1. **AuthN/Z** — bearer token or mTLS (§15); principal must own/claim `name`'s namespace.
2. **Namespace verification** — DNS TXT `_cajeta-publish.<domain>` or
   `.github/cajeta-publish.txt` (enforced server-side, opaque to client).
3. **Integrity** — recompute SHA-256 of `archive`; must equal `metadata.sha256`.
4. **Signature/attestation** — verify detached sig against `key-id` in the trust
   store; verify attestation if present (§15).
5. **Immutability** — reject if `(name,version)` already exists (409).
6. **Store** — put bytes at `blob/<sha256>` (R2) + pointer paths; upsert
   `packages`/`versions`/`blobs` (D1); parse manifest → README/keywords.
7. **Index-on-publish** — upsert into Algolia + `packages_fts` (searchable in
   seconds, no rebuild).
8. **Transparency log** — append `(sha256, signed-at, sig, key-id)`.

**Deliverables**
- [ ] `routes/publish.ts` implementing steps 1–8 with structured error JSON.
- [ ] Multipart parser tolerant of optional fields (unsigned dev publishes allowed only when `ALLOW_UNSIGNED=1`).
- [ ] Yank/retract endpoint or admin path (`retracted=1` + reason) that also updates the search index.
- [ ] Seed/fixture script `scripts/publish-fixture.sh` (publishes a tiny known `.cja` for tests).

**Acceptance criteria**
- [ ] [self] happy path: `scripts/publish-fixture.sh` → `201`; then `GET /v2/resolve?name=$PKG` returns it (§11 AC).
- [ ] [self] integrity guard: tampering one byte of `archive` (sha mismatch) → `400` and **nothing** written (D1 row count + R2 object count unchanged).
- [ ] [self] immutability: re-publishing same `(name,version)` → `409`.
- [ ] [self] authz: publish without/with-wrong token → `401`/`403`.
- [ ] [self] index-on-publish latency: within 10 s of `201`, `GET /v2/search?q=$PKG` returns it (poll loop in the conformance test).
- [ ] [self] transparency: `GET /v2/transparency-log/$SHA` → entry with matching `sha256` (§15).
- [ ] [you] namespace verification against a real domain (DNS TXT) — needs a domain you control; `[self]` against a stubbed verifier in tests.

## 11. Resolve & version index — `GET /v2/resolve`, `GET /:pkg/`, v1 sidecars
`GET /v2/resolve?name=foo&version-constraint=>=1.2.0` → `{resolved:[{name,
version, sha256, retracted, retracted-reason?}]}` (metadata only, no bytes). The
v1 version index `GET <base>/<pkg>/` lists versions (JSON or HTML; client
tolerates both). v1 sidecars (`cajeta.json`, `.cja.sig`, `.cja.sig.keyid`) are
served from pointers. Existing lockfile entries keep resolving; retraction only
warns on **new** resolves.

**Deliverables**
- [ ] `routes/resolve.ts` doing semver-constraint resolution over `versions` (MVS-compatible ordering).
- [ ] v1 version-index route returning JSON (and a minimal HTML view).
- [ ] Sidecar routes for `cajeta.json` / `.sig` / `.sig.keyid`.

**Acceptance criteria**
- [ ] [self] `curl -s "$BASE/v2/resolve?name=$PKG&version-constraint=>=0.0.0" | jq -e '.resolved[0].sha256 | startswith("sha256:")'`.
- [ ] [self] constraint correctness: with versions 1.0.0/1.1.0/2.0.0 seeded, `>=1.0.0,<2.0.0` resolves `1.1.0` (conformance assertion).
- [ ] [self] retracted version surfaces `retracted:true` + `retracted-reason` but still resolves.
- [ ] [self] `curl -s $BASE/$PKG/ | jq -e '.versions | length > 0'` (JSON index).
- [ ] [self] missing package → `404` with JSON error.

## 12. Search — `GET /v2/search?q=…`  ← enable search
Full-text query (paged: `q`, `page`, `hits`) returning `{hits:[{name, version,
description, score}], page, nbHits}`. Backed by Algolia (typo-tolerant) with a
D1-trigram + Levenshtein fallback behind `lib/search-index.ts`. Fed by
index-on-publish (§10) and rebuildable from D1. *(This is the new protocol
surface noted in cajeta-site-plan.md §8.2 — Olla owns it.)*

**Deliverables**
- [ ] `routes/search.ts` + `lib/search-index.ts` provider interface (`algolia` | `d1`).
- [ ] Paging + result shape stable across providers.
- [ ] `scripts/reindex.ts` that rebuilds the Algolia index from D1.

**Acceptance criteria**
- [ ] [self] exact: `curl -s "$BASE/v2/search?q=$PKG" | jq -e '.hits[0].name == "'"$PKG"'"'`.
- [ ] [self] typo tolerance + fallback parity (§5.1 AC) pass under both `SEARCH_PROVIDER=algolia` and `=d1`.
- [ ] [self] paging: `?page=0&hits=1` and `?page=1&hits=1` return disjoint hits; `nbHits` consistent.
- [ ] [self] reindex parity: after `scripts/reindex.ts`, Algolia `nbHits` == `SELECT count(*) FROM packages` (D1).
- [ ] [self] yanked packages drop out of results after retract.

## 13. Single-library download — `GET /v2/blob/:sha256` + v1 artifact paths  ← enable single download
Content-addressed fetch `GET /v2/blob/<sha256>` returns raw bytes; v1 path
`GET <base>/<pkg>/<ver>/<pkg>-<ver>.cja` (+ `.sig`, `.sig.keyid`) resolves the
pointer → same blob. Streamed from R2; strong `ETag` = the digest; cacheable
(immutable). Range requests supported for resumable installs.

**Deliverables**
- [ ] `routes/blob.ts` streaming from R2 with `ETag`, `Cache-Control: public, immutable, max-age=31536000`, `Content-Length`.
- [ ] v1 artifact + sig + keyid routes mapping pointer → blob.
- [ ] HTTP Range support (`Accept-Ranges: bytes`, `206`).

**Acceptance criteria**
- [ ] [self] address integrity: `curl -s $BASE/v2/blob/$SHA | sha256sum` == hex of `$SHA`.
- [ ] [self] v1 path parity: `curl -s $BASE/$PKG/$VER/$PKG-$VER.cja | sha256sum` == same digest.
- [ ] [self] sig + keyid fetch: `.cja.sig` and `.cja.sig.keyid` return `200` with non-empty bodies.
- [ ] [self] caching: response carries `ETag: "$SHA"`; a conditional `If-None-Match: "$SHA"` → `304`.
- [ ] [self] range: `curl -s -r 0-15 $BASE/v2/blob/$SHA | wc -c` → `16`, status `206`.
- [ ] [self] unknown digest → `404`.

## 14. Batched (bundle) download + cross-library dedup — `POST /v2/bundle`  ← enable zipped batch download
Request (JSON): `{have:["sha256:…"], want:[{name, version-constraint}],
transitive, format}`. Response: a single streamed archive holding each included
artifact (`<pkg>-<ver>.cja` + `.sig` + `.sig.keyid`) plus `bundle.json`
(`{entries:[{name,version,sha256}]}`). `have` short-circuits blobs the client
already has (digest-level dedup); `transitive:true` expands + MVS-pins.
`POST /v2/lockfile-diff` is the same stream shape for only changed blobs.

**"Zip" = best cross-library dedup, not per-file DEFLATE.** Plain zip compresses
each member independently and cannot remove sections repeated *across* libraries.
Olla's batch format is built to dedup:

1. **Blob-level dedup (free, already in protocol):** content-addressing +
   `have`/`want` → never send a blob the client holds, and shared transitive
   deps appear once.
2. **Solid stream, large window:** concatenate members into **one tar**, compress
   the whole stream with **zstd long-distance matching** (`--long=27`, ~128 MiB
   window, level ~19). A solid stream lets zstd match repeated sections *across*
   different `.cja` members — the core of "remove duplication of repeated
   sections." Default `format: "tar.zst"` per spec.
3. **Caveat — pre-compressed members defeat the matcher.** `.cja` is itself a
   compressed container, so byte-level matches won't be found across members.
   To get real cross-library dedup we feed the compressor the *uncompressed*
   payloads: store `.cja` entries **store-only** (no inner DEFLATE) in R2 and let
   the bundle's zstd-long do all compression. This is the single biggest dedup win.
4. **`supercompress` capability (advertised in §9):** opt-in enhancements over
   baseline tar.zst, negotiated via the capability flag + `format`:
   - **Trained zstd dictionary** (`zstd --train` over a corpus of package
     payloads) shipped to clients/versioned via well-known — dedups common
     boilerplate (stdlib headers, manifests) even in small/cold bundles.
   - **Content-defined chunking (FastCDC)** with a chunk-addressed store
     (borg/restic/casync/`zchunk` style) — maximal dedup across versions *and*
     packages; `have` then operates at chunk granularity, not whole-blob.
5. **Rollout:** ship baseline `tar.zst` + `--long` + store-only members for the
   operational MVP (`supercompress:false`); add the dictionary, then CDC, behind
   `supercompress:true` once measured. Never advertise a mode not implemented.

**Deliverables**
- [ ] `routes/bundle.ts` + `lib/bundle-codec.ts`: tar assembly, zstd(`--long`) stream, `bundle.json` index, `have`/`want`/`transitive` honoring.
- [ ] Store-only `.cja` ingestion path (§4/§10) so members are dedup-friendly.
- [ ] `POST /v2/lockfile-diff` returning the changed-blobs stream; `404` + hint on snapshot miss.
- [ ] `supercompress` design doc + behind-flag implementation (dictionary first, CDC later); capability advertises only what's live.
- [ ] `scripts/measure-dedup.sh` comparing bundle size vs Σ(individual `zstd -19`) on a corpus with shared sections.

**Acceptance criteria**
- [ ] [self] shape: `curl -s -X POST $BASE/v2/bundle -d '{"want":[{"name":"'"$PKG"'","version-constraint":">=0.0.0"}],"transitive":true,"format":"tar.zst"}' -o b.tzst`; `zstd -dc b.tzst | tar -t` lists `$PKG-*.cja`, `.sig`, `.sig.keyid`, and `bundle.json`.
- [ ] [self] content-type is `application/x-tar-zstd`; `bundle.json` `entries[].sha256` match the contained members' digests.
- [ ] [self] `have` dedup: repeating the request with one member's digest in `have` **omits** that member (entry count drops by exactly one).
- [ ] [self] **cross-library dedup works:** `scripts/measure-dedup.sh` shows the bundle of two libraries sharing a common section is **smaller than** the sum of their independently-`zstd`-compressed sizes (ratio reported; gate: < 0.95×).
- [ ] [self] `--long` helps: same corpus bundled with `--long=27` is ≤ the default-window size (measured by the script).
- [ ] [self] lockfile-diff: a `from→to` with one bumped version returns a stream whose `bundle.json` contains **only** the changed blob.
- [ ] [self] if `supercompress:true` is advertised, a `format` requesting it round-trips (client decode → byte-identical artifacts); if `false`, requesting it → `400`/falls back to `tar.zst`.

## 15. Auth, signatures & trust
Fetch and publish share auth shape: **bearer token** (`Authorization: Bearer`)
or **mutual TLS**. Publish additionally requires namespace ownership. Artifacts
are signed (detached `.sig` + `key-id`); a **transparency log** records each
publish and install fails if a signature is missing or doesn't verify against a
trusted log key. Namespace proof: DNS TXT `_cajeta-publish.<domain>` or
`.github/cajeta-publish.txt`.

**Deliverables**
- [ ] `lib/auth.ts`: bearer-token issue/verify (hashed in `publish_tokens`), optional mTLS path, scope checks.
- [ ] `lib/signature.ts`: detached-signature + attestation verification against a configured trust store (key-id → public key); secrets via `wrangler secret`.
- [ ] Namespace verifier (DNS-over-HTTPS TXT lookup + GitHub raw-file check) with cached `namespaces` proofs.
- [ ] `GET /v2/transparency-log/:sha256` returning the log entry; append-on-publish (§10).
- [ ] Admin/token CLI doc (`docs/operating.md`): mint a publish token, rotate keys.

**Acceptance criteria**
- [ ] [self] bad/no token on publish → `401`/`403` (§10 AC).
- [ ] [self] signature verify: a fixture signed with a known test key verifies (`201`); a corrupted `.sig` → `400`.
- [ ] [self] `GET /v2/transparency-log/$SHA` → `{sha256,signed-at,log-entry-signature,log-entry-key-id}` with matching digest; unknown digest → `404`.
- [ ] [self] namespace verifier unit test: stubbed DNS TXT present → allowed; absent → denied.
- [ ] [you] end-to-end namespace check against a real domain you control (DNS TXT live).

## 16. CI/CD, deploy & spec conformance
GitHub Actions: typecheck + unit tests on PR; `wrangler deploy` on merge to a
release branch (staging → prod). The **`spec/` submodule** pins the cajeta spec
commit; the conformance suite (`test/conformance/`) runs against a `wrangler dev`
instance and asserts every endpoint's shape matches the spec — so client/server
can't drift (§1). Optional: run cajeta's C++ `HttpRepositoryV2Tests` against a
staging URL as an integration gate.

**Deliverables**
- [ ] `.github/workflows/ci.yml` (lint, typecheck, unit, conformance on PR).
- [ ] `.github/workflows/deploy.yml` (wrangler deploy to staging on merge; prod on tag), using `CLOUDFLARE_API_TOKEN` repo secret.
- [ ] `spec/` submodule pinned + a make/npm target to bump it.
- [ ] Conformance suite covering §9–§15 endpoints against the spec fixtures.

**Acceptance criteria**
- [ ] [self] `npm run test:conformance` exits 0 against local `wrangler dev`.
- [ ] [self] `wrangler deploy --dry-run --env staging` exits 0.
- [ ] [self] CI is green on a scratch PR (workflow run concludes `success`): `gh run list --limit 1 --json conclusion`.
- [ ] [you] merge deploys to staging and `curl -sI https://staging-olla.<…>/.well-known/cajeta-capabilities.json` → `200` (needs CF token in repo secrets).
- [ ] [self] drift guard: bumping `spec/` to a commit that changes a shape makes `test:conformance` fail until the server updates.

## 17. Observability & ops
Workers logs + Logpush/Tail, a request counter, and per-endpoint error rates;
billing alerts (§6); a short runbook for the common failures (publish rejected,
search stale, blob 404, bundle decode error).

**Deliverables**
- [ ] Structured logging (request id, route, status, latency) + `wrangler tail` usable.
- [ ] Minimal metrics (Workers Analytics Engine or counters) for publish/search/download/bundle.
- [ ] `docs/runbook.md` covering the top failure modes + how to reindex/rebuild from D1.
- [ ] Billing alerts on Cloudflare + Algolia.

**Acceptance criteria**
- [ ] [self] `wrangler tail` (or local logs) shows one structured line per request with status + latency.
- [ ] [self] forcing an error (e.g. malformed publish) emits a log line tagged with the route and a `5xx`/`4xx` and a request id.
- [ ] [self] `docs/runbook.md` exists and links each failure mode to a recovery command (e.g. `scripts/reindex.ts`).
- [ ] [you] billing alerts visible/enabled in both dashboards.

---

## 18. Related / open work tracked in `cajeta`
- **Spec additions:** `GET /v2/search?q=` + **index-on-publish** hook in
  `POST /v2/publish` (this server implements them; the wire wording lands in
  `cajeta/cajeta-docs/specs/repository-protocol-v1.md`). cajeta-site-plan.md §8.2/§13.
- **Endpoint rename:** `repo.cajeta.org → olla.cajeta.dev` across
  `cajeta-docs/specs/*` and the build-tool default (§2).
- **`supercompress` wording:** once §14's enhanced modes ship, document the
  negotiated `format` values + dictionary distribution in the protocol spec.

**Acceptance criteria (verifiable in the `cajeta` repo)**
- [ ] [self] `grep -rn "repo.cajeta.org" cajeta/cajeta-docs cajeta/src` → none remain.
- [ ] [self] the protocol spec documents `GET /v2/search` and the publish index hook (`grep -n "/v2/search" cajeta/cajeta-docs/specs/repository-protocol-v1.md`).
- [ ] [self] build-tool default repo URL is `olla.cajeta.dev` (grep in `cajeta/src/cajeta/buildtool/repo/`).
