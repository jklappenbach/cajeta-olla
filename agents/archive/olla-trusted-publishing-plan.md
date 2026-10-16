# olla-trusted-publishing — plan

Spec: `specs/olla-trusted-publishing-spec.md`. Approved by Julian
2026-10-15 ("Yes, OIDC trusted publishing"). The signing key stays where it
is (spec §7) until he chooses.

## Description

`POST /v2/publish` accepts a GitHub Actions OIDC identity token as its
bearer, verified against GitHub's key set, and maps the token's repository
to an organization through a binding the owner administers. The composite
publish action requests that token itself. No repository holds
`OLLA_TOKEN` afterwards.

## Systems

- Olla (this repo): Hono on Cloudflare Workers, D1, vitest under
  `@cloudflare/vitest-pool-workers`. WebCrypto for RS256 (no new
  dependency).
- GitHub Actions OIDC: issuer `https://token.actions.githubusercontent.com`,
  key set at `/.well-known/jwks`, RS256 only (read from the discovery
  document 2026-10-15), claims `repository`, `repository_owner`, `ref`,
  `ref_type`, `workflow_ref`, `job_workflow_ref`, `aud`, `sub`.
- cajeta: `.github/actions/olla-publish` (composite + `olla-publish.mjs`),
  `.github/workflows/lib-release.yml`.
- cajeta-cloud `.github/workflows/ci.yml`.

## Deliverables

1. Migration `0008_publisher_bindings.sql`.
2. `src/lib/oidc.ts` (verify), `src/lib/publishers.ts` (bindings),
   `authenticatePublish` extended, admin endpoints, capability flag.
3. Tests: unit for §2 and §3, a route test for §8.2.
4. The action and both workflows changed; cajeta-cloud's skip branch gone.
5. Bindings created for our six publishing repositories (owner session).

## Unit 1 — Verify a GitHub identity token

### 1.1 TDD
- [x] 1.1.1 A token signed by the test key, with the right issuer and
      audience and a future `exp`, verifies and yields its repository, ref
      and workflow.
- [x] 1.1.2 A token signed by another key is refused with a message naming
      the signature.
- [x] 1.1.3 Wrong issuer, wrong audience, expired, and `nbf` in the future
      are each refused with a message naming the check (spec §2.2, §2.3).
- [x] 1.1.4 A `kid` absent from the cached key set triggers one refetch; a
      key present only after the refetch verifies (spec §2.4).
- [x] 1.1.5 When the key set cannot be fetched, the result is a `503` and
      is not cached (spec §2.4).
- [x] 1.1.6 A bearer that is not three base64url segments never reaches the
      verifier (spec §2.1).

### 1.2 Coding
- [x] 1.2.1 `src/lib/oidc.ts`: `looksLikeJwt`, `verifyGithubIdentity(env,
      token, now, fetchKeys)`, an in-isolate key-set cache with a one-hour
      lifetime, RS256 through `crypto.subtle` (`RSASSA-PKCS1-v1_5`,
      SHA-256), JWK import by `kid`.
- [x] 1.2.2 `Env` gains `OIDC_AUDIENCE?` (default `olla.cajeta.dev`),
      `OIDC_JWKS_URL?` (default GitHub's), `OIDC_JWKS_JSON?` (tests only).

### 1.3 Acceptance
- [x] 1.3.1 No new dependency in `package.json`.

## Unit 2 — Bindings under owner authority

### 2.1 TDD
- [x] 2.1.1 `PUT /v2/admin/publishers/<org>` with an admin token stores a
      binding; `GET` lists it; `DELETE` removes it; each writes an audit row
      with before and after (spec §3.6, §3.7).
- [x] 2.1.2 THE test: a publish token is refused by all three verbs, and so
      is an identity token (spec §3.6).
- [x] 2.1.3 Binding a repository already bound to another organization is
      refused with `409` naming the holder (spec §3.8).
- [x] 2.1.4 Repository comparison is case-insensitive; the stored form is
      lower-case (spec §3.1).
- [x] 2.1.5 A missing ref pattern defaults to `refs/tags/*`.

### 2.2 Coding
- [x] 2.2.1 Migration `0008_publisher_bindings.sql`: `publisher_bindings
      (provider, repository, organization, ref_pattern, created_at,
      created_by)`, primary key `(provider, repository)`.
- [x] 2.2.2 `src/lib/publishers.ts`: `findBinding`, `putBinding`,
      `deleteBinding`, `listBindings`, `refMatches` (glob with `*` only).
- [x] 2.2.3 The three admin routes in `src/routes/admin.ts`.

## Unit 3 — Publish with an identity

### 3.1 TDD
- [x] 3.1.1 A verified token whose repository is bound publishes a signed
      archive through `SELF.fetch` and the release's audit row names the
      repository, ref and workflow (spec §3.5, §5.1, §8.2).
- [x] 3.1.2 A verified token for an unbound repository is `403` (spec §3.3).
- [x] 3.1.3 A verified token whose ref is a branch under a tags-only binding
      is `403` naming ref and pattern (spec §3.4).
- [x] 3.1.4 A bound identity still fails every publisher-trust refusal: no
      key document, a key from another organization, a name outside the
      namespaces (spec §3.5). One test per refusal.
- [x] 3.1.5 The identity path never reads `publish_tokens`: a JWT whose
      sha256 happens to be a stored token hash is still an identity token
      (spec §2.1).
- [x] 3.1.6 Capabilities carry `trusted-publishing: ["github"]` (spec §4.1).

### 3.2 Coding
- [x] 3.2.1 `authenticatePublish` branches on `looksLikeJwt`; the identity
      path returns the binding's organization as principal and the
      identity for the audit row.
- [x] 3.2.2 `publish.ts` records repository, ref and workflow in its audit
      row when present.
- [x] 3.2.3 `capabilities.ts` advertises the flag.

### 3.3 Acceptance
- [x] 3.3.1 `npm test` 120 of 120 and `npm run typecheck` green. `npm run
      test:conformance` unchanged: 12 of 14 on this clone before and after
      (the two failures are the clone's `.dev.vars`, no release signing key
      and no dev relaxation; wrangler needs Node 22).

## Unit 4 — The client side

### 4.1 TDD
- [x] 4.1.1 `olla-publish.mjs` run with no `OLLA_TOKEN` and the two
      `ACTIONS_ID_TOKEN_REQUEST_*` variables pointed at a local stub
      requests a token with `audience=olla.cajeta.dev` and sends it as the
      bearer (a node test beside the script).
- [x] 4.1.2 With `OLLA_TOKEN` set it behaves exactly as before.
- [x] 4.1.3 With neither, it fails naming `id-token: write`.

### 4.2 Coding
- [x] 4.2.1 The composite action's `token` input becomes optional; the
      script requests the identity token.
- [x] 4.2.2 `lib-release.yml`: `id-token: write` on the publishing job; the
      `OLLA_TOKEN` secret input removed.
- [x] 4.2.3 cajeta-cloud `ci.yml`: the same, and the skip branch deleted.

### 4.3 Acceptance
- [x] 4.3.1 Deploy the Worker (Julian's word), bind the six repositories,
      publish one library release with no `OLLA_TOKEN` in its repository
      (spec §8.3), then remove the secret from the five that hold it.
      Done 2026-10-16: 17 repositories bound; primavera 0.3.0 and
      cajeta-cloud 0.3.2 published with no `OLLA_TOKEN`; the secret removed
      from codec, http, logging, primavera and unit.
