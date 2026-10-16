# olla-worker-signing — plan

Spec: `specs/olla-worker-signing-spec.md`. Approved by Julian 2026-10-15
("approved"). Decisions: reuse `cajeta-ci-1`; sign only identity uploads
that arrive unsigned.

## Description

When an upload authenticated by a GitHub identity arrives with no
signature, the Worker signs the archive with the organization's CI key,
held as a Cloudflare secret, and runs the signature through the same
checks a client signature meets. The publish action stops requiring the
signing pair, the workflows stop passing it, and the pair is deleted from
the five repositories that hold it.

## Systems

- Olla (this repo): Hono on Cloudflare Workers, vitest under
  `@cloudflare/vitest-pool-workers`. Ed25519 through the existing
  `signDetached` / `verifyDetached` in `src/lib/signature.ts` (no new
  dependency). Wrangler secrets.
- cajeta: `.github/actions/olla-publish` (`action.yml`, `olla-publish.mjs`,
  `olla-publish.test.mjs`), `.github/workflows/lib-release.yml`, the
  `ci/v1` tag.
- Library workflows: cajeta-cloud, codec, docs, graph, ml, recsys,
  timeseries, xgboost (direct callers of the action).
- The owner's sealed key store, `~/olla-key`.

## Deliverables

1. `src/lib/held-keys.ts`; `POST /v2/publish` signs unsigned identity
   uploads; capability `server-signing: ["github"]`; audit `signed-by`.
2. Tests: unit for spec §2 and §5, a route test for §7.2.
3. The Worker deployed with `ORG_SIGNING_KEYS` set (owner session).
4. The action's signing inputs optional; `lib-release.yml` and eight
   library workflows no longer pass the pair; `ci/v1` moved.
5. A release from a repository that never held the pair; the pair deleted
   from codec, http, logging, primavera and unit.

## Unit 1 — The Worker signs an unsigned identity upload

### 1.1 TDD
- [x] 1.1.1 `heldKey(env, org)` returns the key-id and PEM for an
      organization present in `ORG_SIGNING_KEYS`, `null` for one absent,
      and `null` when the secret is unset or not valid JSON (spec §3.1).
- [x] 1.1.2 An unsigned identity upload for an organization with a held
      key lands `201`, and its stored signature verifies against the
      document's public key for that key-id (spec §2.1, §2.2).
- [x] 1.1.3 A held key-id absent from the document, or outside its
      window, is refused with the same `403` a client key gets (spec §2.2).
- [x] 1.1.4 A client-signed identity upload is verified as today, and the
      held key is not used (spec §2.3).
- [x] 1.1.5 A signature without a key-id, or a key-id without a
      signature, is refused as today (spec §2.4).
- [x] 1.1.6 An unsigned identity upload for an organization with no held
      key is `403` naming the missing server-held key (spec §2.5).
- [x] 1.1.7 An unsigned upload authenticated by a publish token is refused
      as unsigned, even when a held key exists (spec §2.6).
- [x] 1.1.8 A held private key that does not match the document's public
      key is `500` naming a server fault (spec §2.7).
- [x] 1.1.9 The audit row says `signed-by: server` with the key-id for a
      server-signed release and `signed-by: client` for a client-signed
      one (spec §5.1).
- [x] 1.1.10 Capabilities carry `server-signing: ["github"]` (spec §4.1).
- [x] 1.1.11 The secret's PEM appears in no response body and no log line
      across the tests above (spec §3.2).

### 1.2 Coding
- [x] 1.2.1 `Env` gains `ORG_SIGNING_KEYS?`: JSON
      `{ "<org>": { "key-id": "...", "private-key": "<PKCS#8 PEM>" } }`.
- [x] 1.2.2 `src/lib/held-keys.ts`: `heldKey(env, org)`.
- [x] 1.2.3 `publish.ts` step 4: when `auth.identity` is set and neither
      signature nor key-id is present, sign with the held key and set
      `keyId`/`sig` from it; the existing window and verify checks then run
      unchanged, with the §2.7 message when the server's own signature
      fails to verify.
- [x] 1.2.4 Audit `after` gains `signed-by` and `key-id`.
- [x] 1.2.5 `capability.ts` advertises `server-signing`.
- [x] 1.2.6 `wrangler.toml` comment naming the secret beside the existing
      ones. Tests pass `ORG_SIGNING_KEYS` per request, built from each test
      organization's own exported key, rather than a fixed vitest binding.

### 1.3 Acceptance
- [x] 1.3.1 `npm test` green; `npm run typecheck` clean; conformance no
      worse than before (12 of 14 on this clone).

## Unit 2 — Deploy and set the key (owner)

### 2.1 TDD
- [x] 2.1.1 None: verified in production by 2.3.

### 2.2 Coding
- [x] 2.2.1 Julian sets `ORG_SIGNING_KEYS` from the sealed `cajeta-ci-1`
      with `wrangler secret put` (spec §3.3, §6.1). The key never passes
      through a session transcript.
- [x] 2.2.2 Deploy the Worker (Julian's word).

### 2.3 Acceptance
- [x] 2.3.1 `GET /v2/capabilities` on olla.cajeta.dev carries
      `server-signing: ["github"]`.

## Unit 3 — The client stops sending the pair

### 3.1 TDD
- [x] 3.1.1 `olla-publish.mjs` with no signing pair uploads without
      `signature` and `key-id` fields when the stub registry advertises
      `server-signing` (spec §4.2).
- [x] 3.1.2 With both inputs empty strings it behaves as with neither.
- [x] 3.1.3 With no pair and no `server-signing` advertised, it fails
      before uploading, naming the capability.
- [x] 3.1.4 With the pair it signs exactly as before.

### 3.2 Coding
- [x] 3.2.1 `action.yml`: `signing-key-pem` and `signing-key-id` become
      `required: false`, default `''`.
- [x] 3.2.2 `olla-publish.mjs`: sign only when both are non-empty;
      otherwise probe capabilities and upload unsigned.
- [x] 3.2.3 `lib-release.yml`: stop declaring and passing the pair.
- [x] 3.2.4 Move `ci/v1` to the commit carrying 3.2.1–3.2.3.
- [x] 3.2.5 cajeta-cloud, codec, docs, graph, ml, recsys, timeseries and
      xgboost: drop `signing-key-pem` / `signing-key-id` from the publish
      step and correct header comments that name the pair (spec §4.3).

### 3.3 Acceptance
- [x] 3.3.1 Every touched workflow's `main` run is green.

## Unit 4 — Migration

### 4.1 TDD
- [ ] 4.1.1 None: the acceptance is a production release (spec §7.3).

### 4.2 Coding
- [ ] 4.2.1 Release one library that never held the pair (cajeta-cloud
      is the candidate) by tag, Julian choosing the version.
- [ ] 4.2.2 Delete `OLLA_SIGNING_KEY_PEM` and `OLLA_SIGNING_KEY_ID` from
      codec, http, logging, primavera and unit (spec §6.2).

### 4.3 Acceptance
- [ ] 4.3.1 The release lands on Olla; its audit row says
      `signed-by: server`.
- [ ] 4.3.2 `gh secret list` on every bound repository shows no `OLLA_*`
      secret.
