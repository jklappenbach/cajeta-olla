# Olla — Cajeta Package Registry — Infrastructure Plan

> Status: **Plan / design.**
> Scope: the **Olla** registry *service* (server, `/v2` API, web app) and its
> hosting/infrastructure. Served at **`olla.cajeta.dev`**.

> **Provenance.** This plan was extracted from the Cajeta website plan
> (`cajeta/plans/cajeta-site-plan.md`, formerly §15) when Olla split into its own
> repo. The repo-boundary rationale lives in that plan's §1.1; a stub there now
> points here. Cross-references below to "cajeta-site-plan.md §N" refer to that
> document.

The Maven-Central-style package registry for the Cajeta language. **D1 + R2 are
the system of record; Algolia is a derived search index.** Total recurring cost
≈ the domain only until real scale (§6).

---

## 1. Decision: name & repo boundaries
- **Name:** the Maven-Central-style registry property is **Olla** (Spanish for
  the pot caramel is cooked in; memorable via the Ollama echo, which the owner
  considers an asset). Chosen over *Cazo* / *Paila*.
- **Own repository.** Olla (registry *server* + its web/API) lives in **this**
  git repo (`olla`), separate from the `cajeta` compiler repo. (See
  cajeta-site-plan.md §1.1 for the full repo-boundary decision — why the site
  stays in-repo while Olla splits out.) Rationale: different stack (web/TS
  service vs C++/LLVM), a live service with its own security surface and deploy
  cadence, independent protocol versioning, and the "host your own registry"
  goal. (Published *artifacts* live in object storage, not git — §4.)
- **Spec stays canonical in `cajeta`.** The wire contract + schemas remain in
  `cajeta`'s `cajeta-docs/specs/` (`repository-protocol-v1.md`,
  `manifest-v1.json`, `lockfile-v1.json`); the build-tool **client** stays in
  `cajeta`'s `src/cajeta/buildtool/repo/`. This Olla repo *consumes* the spec
  (git submodule or a published schema/test-vector package) and runs
  **conformance tests** against it, so client and server can't drift on the wire
  format.

## 2. Domain scheme (root already owned: `cajeta.dev` @ Namecheap)
- **Canonical root:** **`cajeta.dev`** (already registered at Namecheap).
- **Subdomains** (free under the one root):

  | Host | Serves |
  |------|--------|
  | `cajeta.dev` (apex) | marketing + docs site (`cajeta/site`) |
  | `olla.cajeta.dev` | the **Olla** registry (web app + `/v2` API) |
  | `www.cajeta.dev` | 301 → apex |
  | `docs.cajeta.dev` | optional, only if docs split from the main site |

- **DNS via Cloudflare** — Namecheap stays the *registrar*; we just delegate DNS.
  Removes the apex-CNAME limitation and adds free TLS/CDN.
- **Spec edit:** swap the specs' **`repo.cajeta.org`** → **`olla.cajeta.dev`**
  (e.g. publish endpoint `https://olla.cajeta.dev/v2/publish`) and the build-tool
  default repo URL. `.dev` is HSTS-preloaded → HTTPS everywhere (hosts
  auto-provision certs). *(This edit lands in the `cajeta` repo.)*
- **Optional memorability play:** also grab apex `olla.dev` if free and 301 it to
  `olla.cajeta.dev`.

## 3. Cloudflare setup — itemized steps

**A. Delegate DNS**
1. Create a free Cloudflare account.
2. **Add a site** → enter `cajeta.dev` → choose the **Free** plan. Cloudflare
   scans and imports existing DNS records (review them).
3. Cloudflare assigns **two nameservers** (e.g. `xxx.ns.cloudflare.com`).
4. In **Namecheap** → *Domain List → Manage `cajeta.dev` → Nameservers* →
   **Custom DNS** → paste the two Cloudflare nameservers → save.
5. Wait for Cloudflare to mark the zone **Active** (email; minutes–hours).

**B. DNS records** (Cloudflare → DNS → Records)
6. Apex site: `CNAME  cajeta.dev → <site-project>.pages.dev` (proxied; Cloudflare
   flattens the apex CNAME).
7. `CNAME  www → cajeta.dev` + a Redirect Rule `www → apex` (301).
8. Registry: `CNAME  olla → <olla-app>.pages.dev` (or a Worker route), proxied.
9. (optional) `CNAME  docs → <docs-project>.pages.dev`.

**C. TLS**
10. SSL/TLS → Overview → **Full (strict)**; enable **Always Use HTTPS**.

**D. The site app** *(lives in the `cajeta` repo — listed here for the full DNS picture)*
11. Cloudflare **Pages** → Create project → connect the site's GitHub repo →
    framework preset Next.js (or static export `out/`) → set build command +
    output dir → deploy.
12. Pages project → **Custom domains** → add `cajeta.dev` (+ `www`). Certs auto.

**E. The Olla app (Workers + R2 + D1)** *(this repo)*
13. Scaffold a Worker (or Pages Functions) for the `/v2` API + web UI.
14. **R2:** create bucket `olla-artifacts`; bind to the Worker (`[[r2_buckets]]`
    in `wrangler.toml`).
15. **D1:** `wrangler d1 create olla-catalog`; bind it; apply schema migrations
    (packages / versions / owners) + create an **FTS5** virtual table for search.
16. **Secrets:** `wrangler secret put …` for signature-verification material,
    publish auth tokens, namespace-verification config.
17. Deploy the Worker; in its settings add the **custom domain**
    `olla.cajeta.dev` (or a route). Cert auto-provisions.
18. Smoke test: `curl https://olla.cajeta.dev/.well-known/cajeta-capabilities.json`
    and a `GET /v2/resolve?name=…`.

**F. Wire the site to Olla** *(edits land in the `cajeta` repo)*
19. Point the `/repo` registry client (`lib/registry.ts`) at
    `https://olla.cajeta.dev`.
20. Apply the `repo.cajeta.org` → `olla.cajeta.dev` edits in
    `cajeta-docs/specs/*` and the build-tool default.

## 4. File storage (artifacts) → Cloudflare R2
- **R2** — S3-compatible, **zero egress fees** (decisive for a download-heavy
  registry; S3 egress ~$0.09/GB would dominate cost). ~$0.015/GB-mo storage,
  10GB free tier, native Workers binding.
- Layout: **content-addressed** by SHA-256 (`blob/<sha256>` per protocol), with
  the human path layout (`<pkg>/<ver>/<pkg>-<ver>.cja[.sig|.sig.keyid]`) as
  pointers. Immutable versions; dedup for free; matches `/v2/bundle` `have`/`want`.
- Runner-up: **Backblaze B2** (free egress *to Cloudflare* via the Bandwidth
  Alliance) if ever multi-cloud.

## 5. Catalog DB + search hosting → start serverless
- **System of record: Cloudflare D1** (serverless SQLite, native to Workers).
  The catalog is metadata-only (names, versions, digests, parsed manifest,
  README text) — small and text-only, so SQLite suffices for a long time. $0, no
  server to run. Powers `resolve`, the version index, and feeds search
  (cajeta-site-plan.md §8.2).
- **Upgrade path (Postgres features / scale): Neon** serverless Postgres (free
  tier, Postgres FTS + `pg_trgm`, queried from Workers over HTTP) — no server to manage.
- **Only if a persistent box is truly needed** (e.g. self-hosted Typesense +
  Postgres together): cheapest is **Oracle Cloud Always Free** (4 ARM cores /
  24 GB RAM, $0 indefinitely) or **Fly.io** / a ~$5/mo Hetzner VPS.

### 5.1 Typo tolerance / close-match (critical requirement)
Users **will** mistype package names, so close-match is a hard requirement — and
this is **D1's weakest area**, so don't oversell vanilla FTS5:
- ✅ D1 **supports the FTS5 `trigram` tokenizer** → substring + partial matching;
  catches many typos (a misspelling shares most 3-char trigrams). Caveat: built-in
  trigram needs **≥3-char** queries; cover 1–2-char queries with name prefix match.
- ❌ D1 **does not** support **`spellfix1`** (loadable extension, not in D1's
  fixed set) → no native edit-distance / phonetic "did you mean."

**Decision (do it right immediately): Algolia** is the package search index —
typo tolerance is on by default and tuned, so close-match works without
hand-rolling. **D1 + R2 remain the system of record**; Algolia is a **derived
index updated on publish** (index-on-publish hook, cajeta-site-plan.md §8.2) and
**rebuildable from D1**. Accessed behind the `lib/registry` provider interface so
it stays swappable.
- **Plan: apply to the [Algolia for Open Source (AOS)](https://www.algolia.com/for-open-source)
  program** — 200 units free = **200k records + 200k search requests/mo** (+ up
  to 2M indexing ops; ~$180/mo value), in exchange for a small **"Search by
  Algolia"** badge in results. Cajeta is OSS → fits, and covers registry volume
  for a long time.
- **Dev/bootstrap:** the standard **Build** free tier (1M records / 10k
  requests/mo, no card) until AOS is approved.
- **Cost beyond free:** Grow plan ~**$0.50 / 1k** extra search requests,
  ~**$0.40 / 1k** extra records-mo — metered, so monitor usage.
- **Escape hatch (no cost cliff):** if volume ever makes Algolia pricey, the
  provider abstraction lets us drop in **self-hosted Typesense/Meilisearch**
  (Oracle Cloud Always Free, $0) — same typo-tolerant UX, owned.
- **$0 offline fallback also kept:** D1 trigram + Worker-side Levenshtein rerank
  can serve close-match if Algolia is ever unreachable (degraded but functional).

**Not Elasticsearch.** Cloudflare has **no managed Elasticsearch/OpenSearch**
(its search-adjacent products are D1+FTS5 for keyword and **Vectorize** for
*semantic/vector* search — neither is ES). ES would also be the wrong weight
class here (heavy, always-on, no cheap serverless tier) and its fuzzy search
needs tuning to match what **Typesense/Meilisearch/Algolia** do by default — so
ES is not recommended. *Optional later:* **Vectorize** can add **semantic**
"close match" (find by meaning, e.g. "http client" → `fetchwell`) alongside
lexical typo tolerance — a hybrid, not a replacement for it.

## 6. Cost summary
| Item | Choice | Cost |
|------|--------|------|
| Domain | `cajeta.dev` (owned, Namecheap) | already paid (~$12/yr) |
| DNS + CDN + TLS | Cloudflare Free | $0 |
| Site hosting | Cloudflare Pages | $0 |
| Registry compute | Cloudflare Workers | $0 (free tier) |
| Artifact storage | Cloudflare R2 | $0 to start (10 GB free, no egress) |
| Catalog (system of record) | Cloudflare D1 | $0 (free tier) |
| Search index | **Algolia** (Open Source program) | $0 (200k records + 200k req/mo; "Search by Algolia" badge) |
| **Total recurring** | | **~$12/yr (domain only)** until real scale |

---

## Related / open work (tracked in `cajeta`)
- **Registry search protocol additions** (cajeta-site-plan.md §8.2 / §13): the
  spec needs **index-on-publish** (upsert in `POST /v2/publish`, remove on yank)
  and **`GET /v2/search?q=`**. These are wire-contract changes → land in
  `cajeta-docs/specs/`, then this server implements them.
- **Spec endpoint rename** `repo.cajeta.org` → `olla.cajeta.dev` across
  `cajeta-docs/specs/*` and the build-tool default (§2).
