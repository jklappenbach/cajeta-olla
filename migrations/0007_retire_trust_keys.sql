-- Retire the legacy trust store (publisher-trust §6.1, §6.3).
--
-- `trust_keys` mapped a key-id to a public key with no owner and no window: a
-- key was trusted because it was in the table, and it was put there by anyone
-- holding a publish token. Any registered key verified an upload under any
-- organization's name (§1.4.1). Keys that got there under an authority the
-- design no longer accepts are NOT carried forward — each is re-attested by
-- the owner into a signed organization document, which is the only thing that
-- authorises an upload now.
--
-- The rows are copied into the audit log before the table goes. The log exists
-- to answer "who changed which key, and when" after a compromise, and what was
-- trusted under the old rule is exactly the sort of thing that question gets
-- asked about. It is append-only, so this is the last place the record can be
-- kept without also being a place code might read it back as trust.
INSERT INTO audit_log (occurred_at, actor, action, target, before_state, after_state)
SELECT datetime('now') || 'Z',
       'migration:0007_retire_trust_keys',
       'key.retire',
       key_id,
       json_object(
         'public_key', public_key,
         'principal',  principal,
         'fingerprint', fingerprint,
         'created_at', created_at
       ),
       NULL
FROM trust_keys;

-- Dropped rather than left in place unread. A table that still exists is a
-- table someone re-wires, and §6.3's point about the endpoint holds for the
-- storage behind it: while it exists, the refusal is one query away from
-- being satisfied by the party it constrains.
DROP TABLE IF EXISTS trust_keys;
