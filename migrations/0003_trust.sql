-- Signing trust store (§15). Maps an opaque key-id → a trusted Ed25519 public
-- key (PEM SPKI). Publish verifies a detached signature against the key named
-- by the upload's `key-id`. Also adds the per-version detached signature so
-- the v1 `.sig` path can serve it.

CREATE TABLE IF NOT EXISTS trust_keys (
    key_id      TEXT PRIMARY KEY,
    public_key  TEXT NOT NULL,          -- PEM SubjectPublicKeyInfo (Ed25519)
    principal   TEXT,
    fingerprint TEXT,                    -- sha256 hex of the SPKI DER
    created_at  TEXT NOT NULL
);

-- Publisher's detached 64-byte signature over the .cja, base64-encoded.
ALTER TABLE versions ADD COLUMN signature TEXT;
