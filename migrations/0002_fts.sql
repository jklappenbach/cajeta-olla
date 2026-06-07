-- Full-text search mirror (§8, §12). FTS5 with the `trigram` tokenizer so
-- substring + typo-tolerant matching works without spellfix1 (which D1
-- lacks). The mirror's rowid tracks packages.rowid; readme is folded in
-- from the package's versions on publish.
--
-- packages_fts is a regular (content-storing) FTS5 table, so rows are
-- removed with a plain DELETE (the special INSERT...'delete' command is only
-- for external-content / contentless tables). Kept in sync by triggers:
-- package fields on `packages`, readme on `versions`.

CREATE VIRTUAL TABLE IF NOT EXISTS packages_fts USING fts5(
    name,
    description,
    keywords,
    readme,
    tokenize = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS packages_ai AFTER INSERT ON packages BEGIN
    INSERT INTO packages_fts (rowid, name, description, keywords, readme)
    VALUES (new.rowid, new.name, new.description, new.keywords, '');
END;

CREATE TRIGGER IF NOT EXISTS packages_ad AFTER DELETE ON packages BEGIN
    DELETE FROM packages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS packages_au AFTER UPDATE ON packages BEGIN
    DELETE FROM packages_fts WHERE rowid = old.rowid;
    INSERT INTO packages_fts (rowid, name, description, keywords, readme)
    VALUES (new.rowid, new.name, new.description, new.keywords,
            COALESCE((SELECT readme FROM versions WHERE name = new.name
                      ORDER BY published_at DESC LIMIT 1), ''));
END;

-- A new/updated version refreshes the FTS readme for its package.
CREATE TRIGGER IF NOT EXISTS versions_ai_fts AFTER INSERT ON versions BEGIN
    DELETE FROM packages_fts
    WHERE rowid IN (SELECT rowid FROM packages WHERE name = new.name);
    INSERT INTO packages_fts (rowid, name, description, keywords, readme)
    SELECT p.rowid, p.name, p.description, p.keywords, COALESCE(new.readme, '')
    FROM packages p WHERE p.name = new.name;
END;
