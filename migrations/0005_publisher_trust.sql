-- publisher-trust, server half (spec olla-publisher-trust §2, §3).
--
-- Three things nothing else can land without: somewhere to put a signed
-- document, a credential that is not a publish token, and a record of who
-- changed what.

-- The signed documents olla serves. `envelope` is opaque TEXT and is returned
-- byte for byte as it was signed (spec §2.1) — a parsed-and-reserialised
-- document does not verify, so this column is never round-tripped through a
-- JSON parser on the way in or out.
--
-- `subject` is the organization for kind='org-keys', and '' for the two
-- repository-wide kinds, which keeps one primary key across all three.
CREATE TABLE IF NOT EXISTS signed_documents (
    kind       TEXT NOT NULL,       -- 'org-keys' | 'repository-keys' | 'revocations'
    subject    TEXT NOT NULL,       -- organization, or '' when repository-wide
    envelope   TEXT NOT NULL,       -- the signed envelope, VERBATIM
    issued_at  TEXT NOT NULL,       -- from inside the signature, for §3.4's replay check
    not_after  TEXT,                -- from inside the signature; NULL when open-ended
    key_id     TEXT NOT NULL,       -- the root-key-id the envelope names
    stored_at  TEXT NOT NULL,
    PRIMARY KEY (kind, subject)
);

-- Owner credential (spec §3.5). Mirrors publish_tokens in shape and shares
-- nothing else: a separate table is what makes "a publish token cannot reach
-- an administrative verb" a fact about storage rather than a code convention.
CREATE TABLE IF NOT EXISTS admin_tokens (
    token_hash TEXT PRIMARY KEY,                -- sha256 hex of the bearer token
    principal  TEXT NOT NULL,
    scopes     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    expires_at TEXT
);

-- Every mutation: actor, target, before, after, time (spec §3.10). Covers
-- administrative changes and publish/retract/remove alike.
CREATE TABLE IF NOT EXISTS audit_log (
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at  TEXT NOT NULL,
    actor        TEXT NOT NULL,
    action       TEXT NOT NULL,
    target       TEXT NOT NULL,
    before_state TEXT,              -- JSON, NULL when the target did not exist
    after_state  TEXT               -- JSON, NULL when the target was removed
);

CREATE INDEX IF NOT EXISTS audit_log_target_idx
    ON audit_log (target, occurred_at);

-- Append-only, enforced by the database. The log answers "who changed which
-- key, and when" after a compromise; a log an attacker with write access can
-- edit answers nothing.
CREATE TRIGGER IF NOT EXISTS audit_log_no_update
BEFORE UPDATE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
BEFORE DELETE ON audit_log
BEGIN
    SELECT RAISE(ABORT, 'audit_log is append-only');
END;
