# Olla — launch runbook (Cloudflare)

The ordered list of things **you** do, mostly in the Cloudflare dashboard and
via `wrangler`, to take Olla from "works under `wrangler dev`" to live at
**`olla.cajeta.dev`**. This is the distilled action list; the *why* and the full
acceptance criteria live in [`olla-infrastructure-plan.md`](olla-infrastructure-plan.md)
§2–§3 (this file is the checklist view of those).

Prereqs assumed done: code passes locally (`npm run dev` + `npm run migrate:local`
+ `npm test`), and `cajeta.dev` is registered (at Namecheap). The **only**
non-Cloudflare step below is pasting nameservers at Namecheap (step 4).

---

## 0. One-time account + CLI auth
- [ ] Create a free **Cloudflare account**.
- [ ] `npm i -g wrangler` (or use the repo's local `wrangler`).
- [ ] `wrangler login` → authorizes the CLI against your account.
- [ ] Note your **Account ID** (Cloudflare dashboard → Workers & Pages → right rail).

## 1. Delegate the `cajeta.dev` zone to Cloudflare
- [ ] Dashboard → **Add a site** → `cajeta.dev` → **Free** plan. Let Cloudflare import existing DNS; review the imported records.
- [ ] Cloudflare shows **two nameservers** (`*.ns.cloudflare.com`).
- [ ] **Namecheap** → Domain List → Manage `cajeta.dev` → Nameservers → **Custom DNS** → paste the two Cloudflare nameservers → save. *(only off-Cloudflare step)*
- [ ] Wait until the zone reads **Active** (minutes to a few hours).
- [ ] Verify: `dig +short NS cajeta.dev` → the two Cloudflare nameservers.

## 2. TLS
- [ ] SSL/TLS → mode **Full (strict)**.
- [ ] SSL/TLS → Edge Certificates → enable **Always Use HTTPS**.
  (`.dev` is HSTS-preloaded, so HTTPS is mandatory anyway.)

## 3. Provision Olla's backing services (this repo)
Run from the repo root; these create the **real** (remote) resources the
placeholder ids in `wrangler.toml` stand in for.

- [ ] **R2 bucket** (artifact bytes, `blob/<sha256>`):
      `wrangler r2 bucket create olla-artifacts`
      — matches the `[[r2_buckets]]` binding `BLOBS` / `bucket_name = "olla-artifacts"`.
- [ ] **D1 catalog** (system of record for metadata):
      `wrangler d1 create olla-catalog`
- [ ] Copy the printed **`database_id`** into `wrangler.toml` under
      `[[d1_databases]]` (replace the `00000000-…` placeholder).
- [ ] Apply migrations to the remote DB:
      `npm run migrate:remote`
      (runs `wrangler d1 migrations apply olla-catalog --remote` → applies
      `0001_init`, `0002_fts`, `0003_trust`, `0004_attestation`).

## 4. Secrets & production var overrides
`wrangler.toml [vars]` currently holds **dev-safe** values — flip the unsafe ones
for production. Vars can be overridden per-deploy or edited in `wrangler.toml`;
**secrets must never** go in `wrangler.toml`.

- [ ] Transparency-log signing key (§15) — **secret**, not a var:
      `wrangler secret put LOG_SIGNING_KEY_PEM`
      (and `LOG_SIGNING_KEY_ID` if your build reads it as a secret too).
- [ ] Turn OFF the dev escape hatches for production:
  - [ ] `ALLOW_UNSIGNED = "0"` (dev default is `"1"` — **must** be 0 in prod; enforces Ed25519 publish verification).
  - [ ] `REQUIRE_NAMESPACE = "1"` (dev default `"0"`; require a verified namespace proof on publish).
- [ ] Confirm the rest of `[vars]` are intended for prod: `SEARCH_PROVIDER`
      (`d1` to launch; switch to `algolia` later per §12), `WELL_KNOWN_BUNDLES`,
      `CAPABILITY_TTL_SECONDS`, `BUNDLE_ZSTD_LEVEL`.

## 5. Deploy the Worker + bind the domain
- [ ] Dry run: `npm run build` (`wrangler deploy --dry-run --outdir dist`) exits 0.
- [ ] Deploy: `npm run deploy` (`wrangler deploy`).
- [ ] In the Worker's settings → **Custom Domains** → add **`olla.cajeta.dev`**.
      Cloudflare creates the proxied DNS record and provisions the cert
      automatically. (Equivalent manual DNS: `CNAME olla → <worker>.workers.dev`,
      proxied — but the Custom Domain flow is cleaner.)

## 6. Deploy the registry web UI (Pages, same origin)
- [ ] Cloudflare **Pages** → connect this repo → build the `ui/` Vite app →
      deploy. It serves the static UI and calls the Worker API on the same
      origin (`olla.cajeta.dev`).
- [ ] (The marketing/docs site at the apex `cajeta.dev` lives in the `cajeta`
      repo and deploys as its own Pages project — out of scope for *Olla's*
      launch, listed here only for the full DNS picture.)

## 7. Smoke test (launch acceptance)
- [ ] `dig +short olla.cajeta.dev` → Cloudflare anycast IPs.
- [ ] `curl -sI https://olla.cajeta.dev/.well-known/cajeta-capabilities.json` → `200` over valid TLS.
- [ ] `echo | openssl s_client -connect olla.cajeta.dev:443 -servername olla.cajeta.dev 2>/dev/null | openssl x509 -noout -issuer -dates` → valid, unexpired cert.
- [ ] Capability doc advertises flags that match the deployed code
      (conformance test asserts this; see `test/conformance`).
- [ ] A real publish round-trips: `cajeta` build-tool publishes a test package →
      it resolves via `GET /v2/resolve` and downloads from R2.

## 8. Wire the rest of the ecosystem (lands in the `cajeta` repo)
- [ ] Point the `/repo` front-door client (`lib/registry.ts`) at `https://olla.cajeta.dev`.
- [ ] Apply the `repo.cajeta.org → olla.cajeta.dev` rename across
      `cajeta-docs/specs/*` and the build-tool default repo URL (infra plan §18).

---

### Optional / later
- [ ] Grab apex `olla.dev` and 301 → `olla.cajeta.dev`.
- [ ] Switch search to **Algolia** (`SEARCH_PROVIDER = "algolia"`, §12) once the
      D1 FTS5 path is outgrown — free via Algolia for OSS.
- [ ] Add the CI/CD GitHub Action (§16): typecheck + tests on PR, `wrangler deploy`
      on merge — so launches after this first one are push-button.

### Running cost (per infra plan §13)
DNS + CDN + TLS (Cloudflare Free), Pages, Workers free tier, R2 (10 GB free,
**zero egress**), D1 free tier → **$0/mo** at launch scale; only recurring cost
is the domain (~$12/yr).
