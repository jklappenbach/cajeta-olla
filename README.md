# Olla

**Olla** is the package registry for the [Cajeta](https://github.com/jklappenbach/cajeta)
programming language — a Maven-Central-style registry (search, bundling,
content-addressed artifacts, signed publish). Served at **`olla.cajeta.dev`**.

> Status: **planning.** No service code yet. See
> [`plans/olla-infrastructure-plan.md`](plans/olla-infrastructure-plan.md) for the
> architecture and hosting design.

## Boundaries

- **This repo** holds the registry *service*: the `/v2` API, the web app, and
  infrastructure (Cloudflare Workers + R2 + D1, Algolia search index).
- **The wire spec is canonical in `cajeta`**, not here:
  `cajeta-docs/specs/` (`repository-protocol-v1.md`, `manifest-v1.json`,
  `lockfile-v1.json`). The build-tool **client** also lives in `cajeta`. Olla
  *consumes* the spec and runs **conformance tests** against it so client and
  server never drift on the wire format.
- **The marketing site** (`cajeta.dev`, including the `/repo` front-door page)
  lives in the `cajeta` repo under `site/`.

See `cajeta/plans/cajeta-site-plan.md` §1.1 for the repo-boundary rationale (why
the site stays in-repo while Olla is separate).

## Stack (planned)

| Concern | Choice |
|---|---|
| Compute | Cloudflare Workers (or Pages Functions) |
| Artifacts | Cloudflare R2 (content-addressed by SHA-256, zero egress) |
| Catalog (system of record) | Cloudflare D1 (serverless SQLite) |
| Search index | Algolia (derived, rebuildable from D1) |
| DNS / TLS / CDN | Cloudflare (free) |

Recurring cost ≈ the domain only until real scale.
