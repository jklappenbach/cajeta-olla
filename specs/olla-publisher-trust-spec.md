# olla-publisher-trust — the server half

## 1. Definition

**1.1** This is the server half of publisher-trust. The client half is
complete and shipped in the cajeta toolchain: it verifies an artifact
against the organization that owns its name, using documents a repository
serves. Olla serves none of them, so none of it does anything yet.

**1.2** The contract is already written and approved:
`cajeta-five/specs/schemas/publisher-trust-protocol-v1.md`, with the
requirements it derives from in `cajeta-five/specs/publisher-trust-spec.md`.
This spec says what olla builds to satisfy that contract. **Where the two
disagree, the contract wins** — it is what a shipped client already
enforces, and changing it means changing clients in the field.

**1.3** The problem in one line: a signature that verifies proves somebody
signed the bytes, and today olla cannot say who that somebody is entitled
to be. A key in `trust_keys` is trusted because it is in `trust_keys`. That
is the unbound trust that got GPG removed from PyPI.

**1.4** Two findings in the deployed code make this urgent rather than
theoretical.

**1.4.1** `getTrustKey` resolves a key by `key_id` alone against a
repository-global table, and the publish path never compares the row's
`principal` to the authenticated one. Any registered key verifies an upload
under any organization's name. `POST /v2/keys` authenticates with a publish
token, so a publisher registers its own signing key: one stolen token buys
both.

**1.4.2** `domainForPackage` derives ownership from the first two segments
of a dotted name, so `uk.co.acme.thing` and `uk.co.evil.thing` both resolve
to `co.uk` — a public suffix nobody can hold. Two unrelated publishers
collapse onto one ownership key. The check is also gated behind
`REQUIRE_NAMESPACE` and is off by default.

**1.5 Scope.** Serving the three signed documents; owner-only key
management; organization-scoped keys with validity windows; namespace
ownership as signed data; the upload refusals that keep unverifiable
artifacts out; and the migration off the current key flow.

**1.6 Non-goals.**

**1.6.1** The client. It is built, tested, and out of scope here.

**1.6.2** Signing anything with the root key. Olla never holds it (§3.1).

**1.6.3** Full TUF. No snapshot or timestamp roles, so no rollback or
freeze protection beyond what the documents' own `issued-at` gives. A fully
compromised olla remains out of scope, as it is in the client spec.

**1.6.4** Changing the archive, resolve, blob, bundle, or search surfaces.

**1.7 Constraint — deployment order.** A toolchain release carrying the
production root must ship BEFORE olla serves documents signed by it.
Clients mid-upgrade hold the development root; if olla signs with the
production root first, nothing verifies. The client default flips only
after olla serves documents, which is the client plan's Unit 6.

## 2. Serving the signed documents

Read-only, public, hit by every install. Getting it wrong breaks installs
or, worse, makes verification silently vacuous.

**2.1** When a client requests `/v2/org-keys/<org>` for an organization
with a current document, the signed envelope is returned verbatim, byte for
byte as it was signed.

**2.2** When no document exists for that organization, the response is
`404` — absence, which the client reads as the legacy path.

**2.3** When the key store cannot be reached, the response is `503` and
never `404`. A `404` for a transient fault converts an outage into a
fleet-wide verification bypass.

**2.4** When a client requests `/v2/repository-keys`, the repository
delegation is returned; `404` when the repository delegates nothing.

**2.5** When a client requests `/v2/revocations`, the current revocation
statement is returned; `404` while revocation is unadvertised.

**2.6** When a client resolves a release, the signed release metadata is
carried under `signed` in the same `/v2/resolve` body, so verification
costs no extra round trip.

**2.7** The signed half is authoritative and the plain half is never merged
into it. Both halves are served so one response satisfies a verifying and a
non-verifying client.

**2.8** When a release is retracted, the `retracted` flag inside the SIGNED
payload is what changes, and the metadata is re-signed. A flag carried only
in the plain half is one a mirror clears invisibly.

**2.9** A release whose blob is served always has metadata served for it.
Answering `404` on `/v2/resolve` for a coordinate whose bytes are still
available downgrades the client to the unsigned sidecar and loses the
publisher binding while the install still succeeds. No client can detect
this, so it is a server obligation.

**2.10** When capabilities are requested, `v2` is advertised only when all
of §2 is actually served. A server that implements this contract and
forgets to advertise has disabled verification with no error anywhere.

**2.11** `revocation` is advertised as `false` until re-issuance runs on a
schedule (§6.4). Advertising it makes a missing or expired statement refuse
installs fleet-wide.

## 3. Administration

Write, authenticated, rare. Getting it wrong hands an attacker the ability
to publish as somebody else.

**3.1** Olla never holds the root private key. The operator signs documents
offline; the administrative API accepts the finished envelope. An admin
credential that could produce a root signature would forge any
organization's document, which is the collapse the design exists to bound.

**3.2** When a signed document is uploaded, it is verified against the
trusted root before it is stored, and refused if it does not verify. Olla
stores no document it has not itself checked.

**3.3** When a document is uploaded whose type does not match the endpoint
it was sent to, it is refused. The type discriminator inside the signature
decides, never the URL.

**3.4** When an uploaded document is older than the one already stored for
that organization, it is refused. Accepting it would let a replayed
document reinstate keys the organization has removed.

**3.5** Administrative verbs require an OWNER credential, held in its own
store and minted by its own path. A publish token cannot reach them.

**3.6** When a publish token is presented to an administrative endpoint,
the request is refused. This is the defect in §1.4.1 stated as a
requirement, and it is worth a standing test.

**3.7** An organization cannot modify its own keys. Account compromise and
signing compromise stay separate; that separation is the reason the design
survives a stolen publish token.

**3.8** When the owner revokes a key, no replacement is required.
Compromise response is "stop trusting this key now", and requiring a new
key first would delay the only urgent step.

**3.9** When an organization is deleted while it has published archives,
the owner is shown which archives the deletion makes unverifiable and
confirms before it proceeds. A repository is a delivery hub, not the system
of record for who an organization is, so this warns rather than refuses.

**3.10** Every mutation is authenticated, attributed, and recorded: actor,
target, before, after, and time — for administrative changes and for
publish, retract and remove alike. Who changed which key, and when, is the
question that matters after a compromise, and it cannot be reconstructed
later if it was not recorded at the time.

## 4. Organization identity and namespaces

**4.1** An organization's namespaces are the ones inside its signed key
document. That list is what the server checks and what the client checks,
so the two are one check rather than two mechanisms sharing a name.

**4.2** No code path derives an organization from an archive's name. Dotted
names have no fixed arity, so any rule for "how many leading segments are
the org" is wrong for someone and wrong in the direction an attacker picks.
Ownership is data the server holds.

**4.3** Namespace matching is segment-aware. `dev.cajeta` owns
`dev.cajeta.http` and does not own `dev.cajetaevil`. A plain prefix test
passes every well-behaved example and fails against a name chosen
adversarially.

**4.4** A namespace enters a key document at issuance, on evidence of
control over the corresponding name. The existing DNS TXT and GitHub-file
proofs become that evidence, checked once by the owner, rather than a
lookup performed on every publish.

**4.5** The organization recorded in signed release metadata comes from the
authority that gated the upload, never from the archive's name.

## 5. Upload refusals

These make §2's legacy path a legacy path rather than a standing hole. An
unverifiable artifact must never enter the repository.

**5.1** An upload is refused unless its signature verifies against a key
inside the publishing organization's OWN current key document, usable at
upload time. Being known to the server is not the test.

**5.2** An upload from an organization with no current key document is
refused. There is no key to verify against, and verification is not
something a publisher declines by omission.

**5.3** An upload from an organization whose only key has expired is
refused until a current document is published.

**5.4** An upload of a name outside the organization's namespaces is
refused, matched per §4.3.

**5.5** Registering a key document precedes an organization's first upload.
It is onboarding, not publishing.

**5.6** A re-publish of an existing `(name, version)` is refused. A version
is immutable, so a change is a new version.

## 6. Migration and cutover

**6.1** Keys registered under the old publish-token rule are NOT carried
into the new model. Each is re-attested by the owner into a signed
organization document. A key that got there under an authority the design
no longer accepts has no more standing than one added tomorrow by the same
route.

**6.2** Publishers are blocked until their organization's document is
signed. As of 2026-09-02 that is only our own libraries (Julian), so the
cutover needs no window and no notice: it is one signing session for the
organizations we publish under.

**6.2.1** This is the cheapest this migration will ever be, and it stops
being cheap the moment anyone outside publishes to olla. Do it before that
happens. If external publishers exist by the time this is built, §6.2 no
longer holds and the cutover needs a window, notice, and a grace period —
re-read this clause rather than assuming it.

**6.3** `POST /v2/keys` under publish authority is removed, not deprecated.
While it exists, §5.2's refusal is one API call away from being satisfied
by the party it constrains.

**6.4** Revocation is served but unadvertised until its statement is
re-issued on a schedule. Turning the flag on is a separate, deliberate act.

**6.5** When the toolchain release carrying the production root has not
shipped, olla does not serve documents signed by that root (§1.7).

## 7. Conformance

**7.1** The contract is executable. `OllaContractStub` and
`OllaContractTests` in the cajeta toolchain run the real client against a
server that behaves as documented; pointing the same assertions at olla is
how olla is checked.

**7.2** The clauses with no client-observable surface — §3 and §5 — need
server-side tests, because no client can see them. The contract's §8.3
lists them as checks to write.

**7.3** Two of those are checks that something does NOT exist, and need a
grep or a review gate rather than a test: the administrative surface holds
no root key, and no code path derives an organization from a name.
