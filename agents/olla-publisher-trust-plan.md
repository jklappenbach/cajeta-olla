# Plan — olla-publisher-trust

Spec: `specs/olla-publisher-trust-spec.md` (approved 2026-09-02)

## Description

Build the server half of publisher-trust. Olla serves the three signed
documents a cajeta client already knows how to verify, moves key management
onto an owner credential a publish token cannot reach, scopes keys to an
organization with validity windows, and replaces name-derived namespace
ownership with the signed list.

The client is done. Nothing here changes it. The contract
(`cajeta-five/specs/schemas/publisher-trust-protocol-v1.md`) is approved and
wins on any disagreement — shipped clients enforce it.

## Systems

- **Hono** on Cloudflare Workers — `src/index.ts` mounts route modules.
- **D1** (`olla-catalog`) — the metadata system of record. Migrations in
  `migrations/`, applied with `wrangler d1 migrations apply`.
- **Workers Web Crypto** — `crypto.subtle` with Ed25519 for sign and verify.
  Native, non-extractable keys supported; no external KMS involved.
- **Worker secrets** — `RELEASE_SIGNING_KEY_PEM` / `RELEASE_SIGNING_KEY_ID`
  are already deployed and hold the delegated release key.
- **vitest** — `test/unit` and `test/conformance`; `npm test`.
- **The operator's `olla-key` toolkit** — signs documents offline. Not part
  of this repository, and deliberately so (spec §3.1).
- **`cajeta trust verify-document`** — checks a document with the client's
  own parsers before it is served.

**Storage: D1, not KV** — decided 2026-09-02 after the first argument for
it turned out to be wrong, which is worth recording so nobody re-derives it.

The rejected argument was consistency: KV is eventually consistent to ~60s
and revocation is timeliness-critical. That does not hold up. The window
only exists around a WRITE, and this workload is read-heavy with rare
writes — annual for organization documents and the delegation. Even for
revocation, 60s of staleness against the hours an offline root ceremony
takes is still the win the delegated statement exists to deliver.

Cost does not decide it either. Both are negligible: a document GET is a
single-row primary-key SELECT, so at a million installs a day this stays
inside D1's free tier, and KV's 500x-higher per-read price is still small
money.

What actually decides it:

* **Audit atomicity.** Spec §3.10 requires every mutation recorded. On D1
  the document write and the audit row are one transaction. On KV they are
  two stores that can diverge — document stored, audit write failed, an
  unrecorded mutation — and that is exactly the clause that exists for
  post-compromise forensics.
* **One store.** D1 and R2 are already bound; KV is not. A second store is
  provisioning, config, and another thing in the deploy story.
* **Staleness stays ours to choose.** With an HTTP cache in front of D1 the
  TTL is a number we set per document kind, including zero. KV's
  propagation is a floor underneath whatever we choose.

**The cache is the performance design, not a detail.** An HTTP cache sits
in front regardless, so the origin is hit roughly once per colo per TTL
rather than once per install — which is also why KV's edge-locality
advantage is largely captured already. Unit 3 specifies the TTLs.

## Deliverables

- `/v2/org-keys/<org>`, `/v2/repository-keys`, `/v2/revocations` served.
- Signed release metadata carried under `signed` in `/v2/resolve`.
- An owner credential distinct from publish tokens, and administrative
  endpoints that accept already-signed documents.
- Keys scoped to an organization, with validity windows.
- `domainForPackage` removed from every security-relevant path.
- An audit record for every mutation.
- `OllaContractTests` from the toolchain passing against a running olla.

## Constraint on ordering

Unit 7 must not run before the toolchain release carrying `olla-root-1`
ships (spec §1.7). Everything before it is safe: documents can be stored and
served without any client requiring them, because `v2` is not advertised
until Unit 3 and `revocation` stays false throughout.

## Unit 1 — The document store, the owner credential, the audit log

Schema first. Nothing else can land before there is somewhere to put a
document and a credential that is not a publish token.

### 1.1 TDD
- [x] 1.1.1 An admin token authenticates against `admin_tokens`; an unknown
      token is refused 403 and a missing one 401.
- [x] 1.1.2 THE test: a valid PUBLISH token is REFUSED by admin
      authentication. Spec §3.6, and the defect §1.4.1 describes. It must
      fail before 1.2.2 lands.
- [x] 1.1.3 And the converse — an admin token is refused by
      `authenticatePublish`. Separation has to hold in both directions or it
      is one credential with two names.
- [x] 1.1.4 An expired admin token is refused.
- [x] 1.1.5 `ALLOW_UNSIGNED=1` does NOT relax admin authentication. The dev
      relaxation exists so fixtures can publish; letting it mint owner
      authority would put the whole design behind an env var.
- [x] 1.1.6 A recorded mutation captures actor, target, before, after and
      time, and the log is append-only — an UPDATE or DELETE against it
      fails.

### 1.2 Coding
- [x] 1.2.1 Migration `0005_publisher_trust.sql`: `signed_documents`
      (kind, subject, envelope, issued_at, not_after, key_id, stored_at),
      `admin_tokens` (mirrors `publish_tokens`), `audit_log`.
- [x] 1.2.2 `authenticateAdmin()` in `src/lib/auth.ts`, reading only
      `admin_tokens`.
- [x] 1.2.3 `recordMutation()` — one writer, so no caller invents its own
      shape.
- [x] 1.2.4 A script to mint an admin token, separate from the publish-token
      path.

### 1.3 Acceptance
- [x] 1.3.1 `signed_documents` stores the envelope as opaque TEXT. Olla must
      be able to return it byte for byte; a parsed-and-reserialised document
      does not verify (spec §2.1).

## Unit 2 — Verify and accept signed documents

### 2.1 TDD
- [x] 2.1.1 An envelope signed by the trusted root is accepted and stored.
- [x] 2.1.2 An envelope signed by anything else is REFUSED and not stored.
- [x] 2.1.3 A delegation POSTed to the org-keys endpoint is refused: the
      type discriminator inside the signature decides, not the URL
      (spec §3.3).
- [x] 2.1.4 An organization document POSTed to the delegation endpoint is
      refused, the same test from the other side.
- [x] 2.1.5 A document older than the one already stored is refused
      (spec §3.4) — and the same document is accepted when nothing is
      stored yet. The pair is the check.
- [x] 2.1.6 An expired document is refused at upload, not merely at serve
      time.
- [x] 2.1.7 A revocation is verified against the DELEGATION's keys, never
      the root; a root-signed revocation is refused.
- [x] 2.1.8 The stored bytes are byte-identical to what was uploaded.

### 2.2 Coding
- [x] 2.2.1 `src/lib/envelope.ts` — decode and verify an Ed25519 envelope
      with `crypto.subtle`. Verify over the DECODED payload exactly as
      transmitted; never re-serialise.
- [x] 2.2.2 `CAJETA_ROOT_KEY_PEM` / `CAJETA_ROOT_KEY_ID` as wrangler vars.
      PUBLIC material — a var, not a secret, and never the private half.
- [x] 2.2.3 `src/routes/admin.ts` — POST `/v2/admin/org-keys/<org>`,
      `/v2/admin/repository-keys`, `/v2/admin/revocations`.
- [x] 2.2.4 Every accepted upload writes an audit record.

### 2.3 Acceptance
- [x] 2.3.1 A document produced by the operator's `olla-key` toolkit
      uploads and stores successfully — the real ceremony output, not a
      fixture.
- [x] 2.3.2 Verified by review: no code path in this repository can produce
      a root signature (spec §7.3).

## Unit 3 — Serve the documents

### 3.1 TDD
- [x] 3.1.1 `GET /v2/org-keys/<org>` returns the stored envelope byte for
      byte.
- [x] 3.1.2 An organization with no document returns 404.
- [x] 3.1.3 THE distinction: a D1 failure returns 503, never 404. A 404 for
      a transient fault turns an outage into a fleet-wide verification
      bypass (spec §2.3).
- [x] 3.1.4 `GET /v2/repository-keys` and `GET /v2/revocations` behave the
      same way.
- [x] 3.1.5 Capabilities advertise `v2` and `"revocation": false`.
- [x] 3.1.6 An expired stored document is NOT served — 404, as though
      absent, and a warning is logged. Serving it would push the refusal
      onto every client at once.
- [x] 3.1.7 An organization document is served with a cache lifetime, and
      that lifetime never outlives the document's own `not-after`. A cached
      document outliving its expiry is a stale document a client cannot
      refuse, because it never sees it.
- [x] 3.1.8 THE cache test: a revocation statement is served
      NON-cacheable. Every other document here caches for hours; this one
      must not, because a cached revocation is a revocation an attacker
      gets for free. The pair with 3.1.7 is the check — one document
      cached, one not.
- [x] 3.1.9 A 503 is never cached. Caching a failure turns a transient
      outage into a persistent one.

### 3.2 Coding
- [x] 3.2.1 `src/routes/trust.ts` — the three GET handlers.
- [x] 3.2.2 Cache headers per kind. Organization documents and the
      delegation: `public, max-age=<hours>`, clamped so it never exceeds
      the document's remaining `not-after`. Revocations: `no-store`.
      Errors: `no-store`.
- [x] 3.2.3 One helper decides the header from the document kind, so a new
      endpoint cannot pick its own policy by omission.
- [x] 3.2.4 Capabilities gains `revocation`, defaulting false.

### 3.3 Acceptance
- [x] 3.3.1 A cajeta client with the production root installed fetches and
      verifies the real delegation from a locally running olla.
- [~] 3.3.2 Measure the origin read rate under a repeated-install loop and
      confirm the cache is doing the work — the storage choice assumes the
      origin is hit per colo per TTL, not per install, and an assumption
      that load-bearing deserves one measurement. BLOCKED on Unit 7: this
      needs the real edge cache, and `wrangler dev` has none, so any local
      number would measure the loop rather than the cache. The headers it
      depends on are verified (3.1.7, 3.1.8) — what is unmeasured is
      whether Cloudflare honours them at the rate the D1 choice assumed.

## Unit 4 — Signed release metadata

### 4.1 TDD
- [x] 4.1.1 A publish produces release metadata signed by the DELEGATED
      key, carried under `signed` in the resolve body.
- [x] 4.1.2 The signed payload carries `sha256`, `organization`, `name`,
      `version`.
- [x] 4.1.3 `organization` comes from the authenticated principal, never
      from the archive name (spec §4.5).
- [x] 4.1.4 The plain half is still served for non-verifying clients, and
      the two halves may disagree without the signed one changing.
- [x] 4.1.5 Retracting sets `retracted` INSIDE the signed payload and
      re-signs; the plain flag alone is not enough.
- [x] 4.1.6 Un-retracting works and is audited.
- [x] 4.1.7 A release whose blob is served always resolves — the §2.9
      invariant, asserted over the whole catalog rather than one release.

### 4.2 Coding
- [x] 4.2.1 `src/lib/sign.ts` — sign a payload with
      `RELEASE_SIGNING_KEY_PEM` via `crypto.subtle`.
- [x] 4.2.2 `publish.ts` builds and signs release metadata; store it beside
      the version row.
- [x] 4.2.3 `resolve.ts` carries it under `signed`.
- [x] 4.2.4 Retract re-signs.

### 4.3 Acceptance
- [~] 4.3.1 A cajeta client installs from a local olla and reports the
      publisher binding, end to end. OLLA'S HALF IS DONE and measured
      against the real Worker: publish → `signed` on /v2/resolve, the
      signature verified independently with `openssl pkeyutl -verify`
      against the release public key, `organization` taken from the
      principal (published `evil.example.thing`, signed organization is
      the authenticated principal and not `evil.example`), and retraction
      flipping `retracted` inside the signed payload. What is missing is a
      cajeta PROCESS consuming it, which needs a project fixture and a
      locally-rooted trust chain — the production delegation binds to
      https://olla.cajeta.dev, so a local olla cannot serve it to an
      origin-checking client. Lands with Unit 7, where spec §7.1 puts it:
      pointing OllaContractTests at a running olla is how olla is checked.

## Unit 5 — Upload refusals, and namespaces from the signed list

### 5.1 TDD
- [ ] 5.1.1 THE refusal: an upload signed by a key valid in ANOTHER
      organization's document is refused (spec §5.1). This is the
      cross-organization case §1.4.1 permits today.
- [ ] 5.1.2 An upload from an organization with no current document is
      refused.
- [ ] 5.1.3 An upload from an organization whose only key has expired is
      refused.
- [ ] 5.1.4 A name outside the organization's signed namespaces is refused.
- [ ] 5.1.5 Segment-aware matching: `dev.cajeta` owns `dev.cajeta.http` and
      does NOT own `dev.cajetaevil`.
- [ ] 5.1.6 `uk.co.acme.thing` and `uk.co.evil.thing` do not collide — the
      §1.4.2 regression, written as a test so it cannot come back.
- [ ] 5.1.7 Re-publishing an existing `(name, version)` is refused.
- [ ] 5.1.8 The refusals are unconditional — no env var turns them off, and
      `REQUIRE_NAMESPACE` no longer exists.

### 5.2 Coding
- [ ] 5.2.1 `publish.ts` resolves the publishing organization from the
      authenticated principal, loads its current document, and verifies
      against a key in it that is usable now.
- [ ] 5.2.2 Namespace matching reads the signed document's list,
      segment-aware.
- [ ] 5.2.3 DELETE `domainForPackage` and the `REQUIRE_NAMESPACE` gate.
- [ ] 5.2.4 The DNS/GitHub proofs move to owner-facing evidence gathered at
      issuance (spec §4.4); they no longer run on publish.

### 5.3 Acceptance
- [ ] 5.3.1 `grep -r domainForPackage src/` returns nothing. Spec §7.3 is a
      check that something does not exist, so it needs a grep, not a test.

## Unit 6 — Remove the legacy key path, and re-attest

### 6.1 TDD
- [ ] 6.1.1 `POST /v2/keys` no longer exists — 404, not 403. A deprecated
      endpoint still reachable is still a bypass.
- [ ] 6.1.2 A key present only in the old `trust_keys` table authorises
      nothing.

### 6.2 Coding
- [ ] 6.2.1 Delete the publish-authenticated key registration.
- [ ] 6.2.2 Migration retiring `trust_keys`, or scoping it to the archive
      signatures it still legitimately serves.
- [ ] 6.2.3 Update `docs/` and `olla-ci-publish.md` in the toolchain repo,
      which documents registering your own key as one-time setup.

### 6.3 Acceptance
- [ ] 6.3.1 Sign organization documents for the libraries we publish, and
      upload them. Cheap now because only our own libraries publish —
      spec §6.2.1 says this stops being true the moment anyone external
      does, so it is worth doing before then.

## Unit 7 — Conformance and deploy

**Do not start until the toolchain release carrying `olla-root-1` has
shipped** (spec §1.7).

### 7.1 TDD
- [ ] 7.1.1 `test/conformance` runs the toolchain's contract assertions
      against a locally running olla.
- [ ] 7.1.2 The contract's §8.3 self-checks, which no client can observe:
      the cross-organization refusal, staged-vs-applied reporting, remove
      ordering, and the audit record.

### 7.2 Coding
- [ ] 7.2.1 Wire `test:conformance` to a `wrangler dev` instance.
- [ ] 7.2.2 Apply migrations to production and deploy.

### 7.3 Acceptance
- [ ] 7.3.1 A default-configured cajeta client installs a real library from
      production olla and reports a verified publisher.
- [ ] 7.3.2 Hand back to the toolchain's `publisher-trust` Unit 6, which
      flips the client default. Spec 9.3 there forbids flipping it before
      this point, and this is that point.
- [ ] 7.3.3 `revocation` stays advertised false. Turning it on is separate
      work and needs scheduled re-issuance first (spec §6.4).
