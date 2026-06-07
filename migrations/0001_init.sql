-- Olla catalog — metadata-only relational core (§8).
-- R2 holds the artifact bytes; D1 holds everything *about* them.
-- The FTS mirror + sync triggers live in 0002_fts.sql.

-- One row per package (latest_version is a denormalized convenience the
-- resolve/version-index routes keep current on publish).
CREATE TABLE IF NOT EXISTS packages (
    name           TEXT PRIMARY KEY,
    namespace      TEXT,
    description     TEXT NOT NULL DEFAULT '',
    keywords        TEXT NOT NULL DEFAULT '',   -- space/comma-joined for FTS
    latest_version  TEXT,
    created_at      TEXT NOT NULL               -- ISO 8601
);

-- One row per published (name, version). Immutable once written
-- (publish rejects a duplicate with 409); retraction flips `retracted`
-- in place and is non-destructive.
CREATE TABLE IF NOT EXISTS versions (
    name             TEXT NOT NULL,
    version          TEXT NOT NULL,
    sha256           TEXT NOT NULL,             -- canonical "sha256:<hex>"
    manifest_json    TEXT NOT NULL DEFAULT '{}',
    readme           TEXT NOT NULL DEFAULT '',
    retracted        INTEGER NOT NULL DEFAULT 0,
    retracted_reason TEXT,
    key_id           TEXT,
    published_at     TEXT NOT NULL,             -- ISO 8601
    PRIMARY KEY (name, version)
);
CREATE INDEX IF NOT EXISTS idx_versions_name ON versions (name);
CREATE INDEX IF NOT EXISTS idx_versions_sha  ON versions (sha256);

-- Package ACL — who may publish under a name.
CREATE TABLE IF NOT EXISTS owners (
    name      TEXT NOT NULL,
    principal TEXT NOT NULL,
    role      TEXT NOT NULL DEFAULT 'owner',    -- owner | maintainer
    PRIMARY KEY (name, principal)
);

-- Verified namespace ownership (DNS-TXT / github proof — §15).
CREATE TABLE IF NOT EXISTS namespaces (
    owner       TEXT NOT NULL,
    domain      TEXT NOT NULL,
    method      TEXT NOT NULL,                  -- dns-txt | github
    proof       TEXT,
    verified_at TEXT,
    PRIMARY KEY (domain)
);

-- Content-address index. R2 is the bytes; this is the pointer + size so
-- /v2/blob and the v1 artifact path can resolve a digest to an R2 key.
CREATE TABLE IF NOT EXISTS blobs (
    sha256     TEXT PRIMARY KEY,                -- canonical "sha256:<hex>"
    size       INTEGER NOT NULL,
    r2_key     TEXT NOT NULL,                   -- "blob/<hex>"
    created_at TEXT NOT NULL
);

-- Publish tokens (hashed; the raw token is shown once at mint time).
CREATE TABLE IF NOT EXISTS publish_tokens (
    token_hash TEXT PRIMARY KEY,                -- sha256 hex of the bearer token
    principal  TEXT NOT NULL,
    scopes     TEXT NOT NULL DEFAULT '',        -- space-joined scopes
    created_at TEXT NOT NULL,
    expires_at TEXT
);

-- Append-only transparency log (§15).
CREATE TABLE IF NOT EXISTS transparency_log (
    seq                  INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256               TEXT NOT NULL,
    signed_at            TEXT NOT NULL,
    log_entry_signature  TEXT NOT NULL DEFAULT '',
    log_entry_key_id     TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_translog_sha ON transparency_log (sha256);
