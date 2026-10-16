# olla-trusted-publishing — publish authentication without a stored token

## 1. Definition

**1.1** Today an upload authenticates with a publish token: a bearer minted
by `scripts/mint-publish-token.mjs`, stored hashed in `publish_tokens`, and
copied into a GitHub repository secret (`OLLA_TOKEN`) in every repository
that publishes. On 2026-10-15 five repositories carried it and one
(cajeta-cloud) did not, so its release reached Olla only through
cajeta-logging's `publish-sibling` bridge, run by hand. Julian's decision
that day: the token is not to live in a repository at all.

**1.2** This spec replaces the stored token with trusted publishing. A
GitHub Actions job can ask GitHub for a signed OpenID Connect token that
states which repository, workflow and ref it runs for. Olla verifies that
token against GitHub's published keys and consults a binding it holds,
under owner authority, from a repository to an organization. Nothing is
stored in any repository, on any runner, or anywhere a publisher can
reach. There is no credential to mint, rotate, copy or leak.

**1.3** This is the model PyPI and npm call trusted publishing. The
contract `cajeta/specs/schemas/publisher-trust-protocol-v1.md` leaves it
open: §6.7 says how an organization authenticates in order to upload is
unchanged by that contract, only what the authentication may reach. So
this spec changes nothing a shipped client sees.

**1.4 Scope.** Verifying a GitHub OIDC token on `POST /v2/publish`; the
binding store and its owner-only administration; the refusals; audit; the
capability flag; the client side (the composite action and the library
workflows); migration off `publish_tokens` for our own libraries.

**1.5 Non-goals.**

**1.5.1** The archive signature. An upload is still signed by a key inside
the organization's signed key document (publisher-trust §5.1); that key is
a second secret the repositories hold today (`OLLA_SIGNING_KEY_PEM`). Its
home is a separate decision, recorded in §7.

**1.5.2** Any provider other than GitHub Actions. The binding carries a
provider column so a second one can be added, and nothing else here
assumes it.

**1.5.3** Retiring `publish_tokens` for anyone but ourselves. Tokens keep
working until the owner removes them (§6).

## 2. Authentication

**2.1** When the bearer on `POST /v2/publish` is a JSON Web Token (three
base64url segments whose first decodes to a JSON header naming an `alg`),
Olla treats it as an OIDC identity token and never as a publish token. A
stored token can never be mistaken for an identity token because the two
have different shapes: a publish token for a dotted organization is also
three runs between dots, which is why the header must decode. The identity
path never reads `publish_tokens`.

**2.2** The token is accepted only when every one of these holds:

**2.2.1** Its signature verifies, RS256, against a key in GitHub's current
key set at `https://token.actions.githubusercontent.com/.well-known/jwks`,
selected by the token's `kid`.

**2.2.2** `iss` is exactly `https://token.actions.githubusercontent.com`.

**2.2.3** `aud` contains Olla's audience, `olla.cajeta.dev` by default and
configurable per deployment. A token minted for another audience is
refused: GitHub tokens are otherwise interchangeable across every service
that trusts GitHub.

**2.2.4** `exp` is in the future and `nbf`, when present, in the past, with
sixty seconds of clock allowance.

**2.3** When the signature does not verify, the issuer or audience is
wrong, or the token is expired, the response is `401` with a body that
names which check failed. The failure is not an organization's fault, so
it is not the `403` the §5 refusals use.

**2.4** The key set is fetched from GitHub and cached in the Worker for an
hour. A `kid` that is not in the cached set triggers one refetch before
the token is refused, so a key GitHub rotates in is honoured without
waiting out the cache. When the key set cannot be fetched at all, the
response is `503`, never `401`: a transient fault must not read as a
forged token, and must not be cached (publisher-trust §2.3 and §3.1.9 are
the same rule for documents).

**2.5** For tests, the key set may be supplied as a binding instead of
fetched. Production never sets it.

## 3. Binding a repository to an organization

**3.1** A binding is a row the owner creates: provider (`github`),
repository (`owner/name`, compared case-insensitively as GitHub does),
organization, and a ref pattern. The default pattern admits tags only,
`refs/tags/*`: a release is a tag, and a branch build publishing to a
registry is the mistake the pattern exists to refuse.

**3.2** The publishing organization is the binding's organization and
nothing else. No path derives it from the token's repository name, the
workflow name, or the archive's name (publisher-trust §4.2 and §4.5 apply
unchanged).

**3.3** When a verified token names a repository with no binding, the
response is `403` and says so. Being a real GitHub repository is not the
test; being bound by the owner is.

**3.4** When a verified token's `ref` does not match the binding's
pattern, the response is `403` naming the ref and the pattern.

**3.5** When a binding exists, the upload continues through every
publisher-trust refusal exactly as a token upload does: the organization
must have a current key document, the archive must be signed by a key in
it, and the name must lie inside its namespaces. Trusted publishing decides
who is uploading; it does not relax what they may upload.

**3.6** Bindings are administered under OWNER authority only:
`PUT /v2/admin/publishers/<org>` with a body naming provider, repository
and optional ref pattern creates or replaces one; `DELETE` with the same
body removes it; `GET` lists the organization's bindings. A publish token
presented to any of them is refused (publisher-trust §3.6 is the standing
test; this adds three endpoints to it). An identity token presented to
them is refused too: a repository can publish, never change who may.

**3.7** Every binding change is audited through `recordMutation`, with the
row before and after, so the question after a compromise, which
repository was allowed to publish as whom and since when, is answerable
from the log.

**3.8** A repository may be bound to at most one organization. Two
organizations claiming one repository is a configuration error the owner
resolves, not a choice the server makes at publish time.

## 4. Capability and client

**4.1** Capabilities advertise `trusted-publishing: ["github"]` only when
§2 and §3 are served, so a client can tell a registry that supports it
from one that does not, and the composite action can fail early rather
than send an identity token to a server that would read it as a bad
bearer.

**4.2** The composite action `cajeta/.github/actions/olla-publish`
requests an identity token from GitHub with Olla's audience when its
`token` input is empty and the job has `id-token: write`, and sends it as
the bearer. With a `token` input it behaves as before. It never requires
`OLLA_TOKEN`.

**4.3** `lib-release.yml` and cajeta-cloud's `ci.yml` grant `id-token:
write` to the job that publishes and stop passing `OLLA_TOKEN`. The
"publish is SKIPPED" branch in cajeta-cloud's workflow goes away: with
nothing to copy, there is nothing to be missing.

## 5. Audit

**5.1** A publish authenticated by an identity token records, in the audit
row the publish already writes, the repository, ref and workflow the token
named. A token publish records the token's principal as today. The two are
distinguishable in the log.

## 6. Migration

**6.1** The owner binds each of our publishing repositories to its
organization in one session: cajeta-logging, cajeta-http, cajeta-codec,
cajeta-unit, cajeta-primavera and cajeta-cloud to `dev.cajeta`, and the
others as they first publish.

**6.2** After each repository has published once through its identity, the
owner deletes `OLLA_TOKEN` from the repository's secrets and may revoke the
publish token's row. Nothing in this spec deletes a secret; GitHub
secrets are the owner's to remove.

**6.3** `publish_tokens` remains for publishers outside GitHub Actions and
for the local seed flow, which is why §2.1 keeps the two paths separate
rather than removing one.

## 7. The signing key, deferred

**7.1** After this spec, each publishing repository still holds
`OLLA_SIGNING_KEY_PEM` and `OLLA_SIGNING_KEY_ID`, because publisher-trust
§5.1 requires the upload to be signed by a key in the organization's
document, and that key is where the organization's authority lives
(publisher-trust §3.7: an account compromise and a signing compromise stay
separate).

**7.2** Two ways to take it out of the repositories, for Julian to choose:
the Worker holds one delegated CI signing key per organization as a
Cloudflare secret and signs what it accepts from a verified identity,
which collapses the two compromises into one but keeps every secret in
Cloudflare; or the key stays in the repository, which keeps the separation
and the secret. Neither is built here.

## 8. Conformance

**8.1** Unit tests mint identity tokens with a test RSA key and a key set
supplied through the §2.5 binding, so every §2 and §3 clause with a
refusal has a test that fires it and a test that passes it.

**8.2** The route test publishes a real archive through `SELF.fetch` with
an identity token, through every publisher-trust refusal, and lands a
release whose audit row names the repository.

**8.3** The first production publish through an identity token is the
acceptance: a library release lands on Olla with no `OLLA_TOKEN` in its
repository.
