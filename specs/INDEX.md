# Active work

One row per in-flight spec. `draft` while the spec and plan are being
authored, `active` once approved, `blocked` when stalled. Closing a plan
removes its row — the archived spec + plan pair is the durable record.

| Spec | Plan | Status |
|---|---|---|
| [olla-publisher-trust](olla-publisher-trust-spec.md) | [plan](../agents/olla-publisher-trust-plan.md) | **active** — approved 2026-09-02. The SERVER half of publisher-trust: serve organization key documents, the repository delegation and revocations; owner-only key management on a credential separate from publish tokens; keys scoped to an organization with validity windows; namespace ownership as signed data instead of `domainForPackage`'s name derivation. Implements `cajeta-five/specs/schemas/publisher-trust-protocol-v1.md`, which is approved and wins on any disagreement. Two live defects drive it: the repository-global `trust_keys` whose `principal` is never compared on publish, and `domainForPackage` collapsing `uk.co.acme.thing` and `uk.co.evil.thing` onto `co.uk`. Decisions taken 2026-09-02: upload already-signed envelopes (no staging state), a separate admin credential table, re-attest existing CI keys rather than inherit them (free right now — only our own libraries publish, §6.2), and serve revocation without advertising it. |
