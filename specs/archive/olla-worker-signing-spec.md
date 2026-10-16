# olla-worker-signing — the Worker signs identity uploads

## 1. Definition

**1.1** After olla-trusted-publishing, a GitHub Actions job authenticates
to Olla with its identity and holds no `OLLA_TOKEN`. The upload must still
be signed by a key in the organization's root-signed key document
(publisher-trust §4.1), so every publishing repository also holds
`OLLA_SIGNING_KEY_PEM` and `OLLA_SIGNING_KEY_ID`. On 2026-10-15 five
repositories held that pair and ten did not; the ten cannot publish.

**1.2** This spec implements olla-trusted-publishing §7.2 option A, chosen
by Julian 2026-10-15: the Worker holds the organization's CI signing key
as a Cloudflare secret and signs an upload that a verified identity sends
unsigned. No repository holds any Olla secret.

**1.3** The key is `cajeta-ci-2`, added to dev.cajeta's key document
beside `cajeta-ci-1` (both valid to 2027-09-03). Reusing `cajeta-ci-1` was
the first choice, but its private half was never sealed and is lost
(found 2026-10-16). It stays in the document so the releases it signed
still verify; no one can sign with it once §6.2 runs.

**1.4 What this trades.** A repository's secrets are readable by any
workflow in it, so push access to a publishing repository already reached
the signing key; that does not change. What changes is that the key's
reach moves from fifteen repositories to one Cloudflare account, which
already holds the delegated key that signs release metadata
(`RELEASE_SIGNING_KEY_PEM`). A Cloudflare compromise could already sign
any release a client trusts; holding the upload key adds little to it.
The root key stays offline, and the Worker never signs a key document
(publisher-trust §6.4).

**1.5 Scope.** Server-side signing on the identity path; the secret that
holds the key; the refusals; audit; a capability flag; the client side
(the action and the library workflows); removing the signing pair from
the repositories.

**1.6 Non-goals.**

**1.6.1** Removing `cajeta-ci-1` from the document. It leaves at the
document's next annual reissue.

**1.6.2** Signing an upload authenticated by a publish token. A leaked
token must not yield a signed release.

**1.6.3** Signing anything but an upload's archive: key documents,
delegations and revocations remain root-signed offline.

## 2. Signing

**2.1** When an upload authenticated by a GitHub identity carries no
signature and no key-id, the Worker signs the archive bytes with the key
it holds for the publishing organization and continues as if the client
had sent that signature and key-id.

**2.2** The server-made signature then meets every check a client
signature meets: the key-id must name a key in the organization's own
current document, usable now, and the signature must verify against that
key's public half. A held key that has fallen out of the document, or out
of its window, is refused exactly as a client key would be.

**2.3** When the upload carries a signature, the Worker verifies it as
today and signs nothing. A repository that still holds the pair keeps
working through the migration.

**2.4** When the upload carries a signature without a key-id, or a key-id
without a signature, it is refused as today.

**2.5** When an unsigned identity upload names an organization for which
the Worker holds no key, the response is `403` saying that no
server-held key exists for that organization and the upload must be
signed.

**2.6** When an unsigned upload is authenticated by a publish token, it is
refused as unsigned, as today (§1.6.2).

**2.7** When the held key's private half does not match the public key
the document lists under its key-id, the upload is refused and the
response names the mismatch as a server fault, not the publisher's.

## 3. The held key

**3.1** The key is a Cloudflare secret on the Worker, addressed by
organization, so a second organization needs a secret entry and no code
change.

**3.2** The secret carries the key-id and the Ed25519 private key (PKCS#8
PEM). It is never logged, never returned by any endpoint, and never
written to D1 or R2.

**3.3** The owner's sealed copy in `~/olla-key` remains the source of
truth and the recovery path. Setting the secret is an owner act with
`wrangler secret put`; nothing in the Worker writes it.

**3.4** The CI private key is in the sealed set, so `cleanup.sh` refuses
to shred it before it is sealed.

## 4. Capability and client

**4.1** Capabilities advertise `server-signing: ["github"]` only when §2
is served, so the action can tell a registry that will sign from one that
will refuse an unsigned upload.

**4.2** In the composite action `cajeta/.github/actions/olla-publish`,
`signing-key-pem` and `signing-key-id` become optional. With both, it
signs as before. With neither, or both empty (an unset secret arrives as
an empty string), it uploads unsigned, after checking §4.1
and failing early, naming the missing capability, when the registry does
not advertise it.

**4.3** `lib-release.yml`, cajeta-cloud's `ci.yml` and the seven library
workflows that call the action directly stop passing the signing pair.

## 5. Audit

**5.1** A release the Worker signed records that in its audit row
(`signed-by: server`), with the key-id. A client-signed release records
`signed-by: client`. The two are distinguishable in the log.

## 6. Migration

**6.1** The owner generates `cajeta-ci-2`, signs a dev.cajeta document
carrying both keys with the root, uploads it, sets the secret from
`cajeta-ci-2`, and seals the key.

**6.2** After one library releases through server signing, the owner
deletes `OLLA_SIGNING_KEY_PEM` and `OLLA_SIGNING_KEY_ID` from the five
repositories that hold them. After that, no repository holds an Olla
secret.

**6.3** The ten repositories without the pair publish on their next tag
with no repository change beyond §4.3.

## 7. Conformance

**7.1** Unit tests supply a test key through the secret's binding, so
each §2 clause has a test that fires its refusal and one that passes it.

**7.2** The route test publishes an unsigned archive with an identity
token through `SELF.fetch` and lands a release whose stored signature
verifies against the document's key and whose audit row says
`signed-by: server`.

**7.3** The first production release from a repository that never held
the pair is the acceptance.
