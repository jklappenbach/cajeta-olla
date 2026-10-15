-- Trusted publishing (olla-trusted-publishing §3). A binding maps a
-- repository, as a verified GitHub Actions identity names it, to the
-- organization it may publish as. Owner-administered; every change is a row
-- in audit_log. One organization per repository: the primary key.
CREATE TABLE IF NOT EXISTS publisher_bindings (
    provider     TEXT NOT NULL,          -- 'github'
    repository   TEXT NOT NULL,          -- lower-cased owner/name
    organization TEXT NOT NULL,
    ref_pattern  TEXT NOT NULL,          -- '*' wildcards; default 'refs/tags/*'
    created_at   TEXT NOT NULL,
    created_by   TEXT NOT NULL,          -- the owner principal that bound it
    PRIMARY KEY (provider, repository)
);
CREATE INDEX IF NOT EXISTS publisher_bindings_org_idx
    ON publisher_bindings (organization);
