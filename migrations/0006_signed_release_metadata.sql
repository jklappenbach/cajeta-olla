-- Signed release metadata (publisher-trust §2.6 – §2.8).
--
-- The release's own signed statement, made by a key the repository delegation
-- names, stored beside the version it describes and returned verbatim under
-- `signed` on /v2/resolve. Opaque TEXT for the same reason signed_documents
-- is: the signature covers the transmitted bytes, so a document parsed on the
-- way in and reserialised on the way out no longer verifies.
ALTER TABLE versions ADD COLUMN signed_metadata TEXT;

-- The publishing organization, taken from the AUTHENTICATED PRINCIPAL at
-- upload (§4.5). Never derived from the archive's name: a name is a string
-- the publisher chooses, and deriving ownership from one is the defect this
-- design exists to remove.
ALTER TABLE versions ADD COLUMN organization TEXT;
