-- Build provenance attestation (§15). The in-toto Statement v1 / SLSA
-- provenance v1 envelope uploaded with a publish (the `attestation` field).
-- Stored verbatim so `cajeta install` can fetch the `<archive>.attestation`
-- sidecar and re-check it.
ALTER TABLE versions ADD COLUMN attestation TEXT;
