# olla-skill-index — index what a library is for, from its skills

## 1. Definition

**1.1** Every published version carries its skills: `skills/index.json` and
one `skills/<id>.md` per skill, written by the compiler at build time, each
with machine-facing frontmatter (`id`, `applies-to`, `title`,
`description`). This spec reads them at publish, indexes them against the
package and version, and lets a search over a goal find the library whose
skills say it does that.

**1.2** The problem: search ranks prose above purpose. Measured 2026-09-25
on the live registry, `q=identity` returns `dev.cajeta.xgboost`, whose
readme mentions the word, and not `dev.cajeta.cloud`, which holds the
identity port. The skill frontmatter states purpose in one line per skill,
and nothing reads it. The `keywords` column exists and no manifest fills it.

**1.3** It is cheap, for the reason the class index is cheap
(`olla-class-index-spec.md` §1.3): the trailing index names every entry, so
`skills/index.json` is one ranged read, and each skill member is a small
Markdown file whose frontmatter is the first few hundred bytes. Skill members
are compressed in the archive and are decompressed to read; there are dozens
per library, not thousands.

**1.4 Scope.** Extracting the skill index and each skill's frontmatter from a
published archive; an index keyed by package, version and skill id; skills
as a matched field on `/v2/search`; ranking that puts purpose above prose;
endpoints that serve a version's skill index and a skill's payload; a
backfill over what is already published.

**1.5 Non-goals.**

**1.5.1** Rendering or validating skill bodies. The body is served as
published.

**1.5.2** A new search provider. This works with D1 FTS5 and with Algolia.

**1.5.3** Ranking by usage. Olla does not record downloads.

**1.6 Client.** The consumer is the compiler MCP server's `findLibraries`
tool and its `getSkills` remote read, `cajeta/specs/library-discovery-spec.md`.
That spec owns the tool; this one owns what the registry stores and serves.

## 2. Reading skills from an archive

**2.1** When an archive is scanned at publish, `skills/index.json` is located
through the trailing index and read. An archive with no such entry has no
skills and is indexed with none; publishing proceeds.

**2.2** When `skills/index.json` is present and does not parse as the
`skill-index-v1` schema, the archive is refused at upload, like an
unscannable class list (class-index §6.1). A library that claims skills and
serves a broken index would be a search result that cannot be read.

**2.3** When the index is read, each skill's member is read and its
frontmatter parsed for `id`, `title`, `description` and `applies-to`. A
member the index names that is absent is a refusal under §2.2.

**2.4** When the archive's manifest says its kind is not the library form,
its skills are not indexed, for the reason of class-index §2.6. Skills under
`deps/` are never indexed.

**2.5** When an archive is malformed part-way through, the skills read so far
are discarded and the archive is refused. A partial skill list reads as a
complete answer.

## 3. The index

**3.1** The index holds one row per package, version and skill id, with
title, description and the `applies-to` names joined as text.

**3.2** Rows are immutable once written, because the version is. A retract
removes the version's rows; a removal removes them.

**3.3** Skill text is scored in its own FTS table, not folded into
`packages_fts`, for the reason of class-index §4.7: a library with forty
skills must not become a large document that skews every other query.

**3.4** Retracted versions are not searchable. The latest non-retracted
version's skills are what a search matches by default.

## 4. Search

**4.1** When a query matches a skill's title, description or applies-to
names, that library is a hit on `/v2/search`, alongside matches on name,
description, keywords, readme and classes.

**4.2** When a hit matched on a skill, the response carries the skill's id,
title, description, the version it was found in and its
`cja-skill://<name>@<version>/<id>` URI. A hit that matched only the
package's own fields carries no skills.

**4.3** When a query matches a package's description or keywords, or a
skill's title or description, that hit ranks above a hit that matched only
the readme. Implementation is the provider's business: bm25 column weights
on D1, custom ranking on Algolia. The ordering is the requirement.

**4.4** When a search is to be restricted to skills, `scope=skills` does it,
beside the class restriction the class-index spec adds. The default searches
everything.

**4.5** The added field is optional. A client that does not know it is
unaffected.

## 5. Serving skills

**5.1** When a client asks `GET /v2/skills/:name/:version`, the response is
that version's `skills/index.json` as published, byte for byte, so the
compiler's SkillIndex parses it. Absent skills answer an empty index, not
404; an unknown version answers 404.

**5.2** When a client asks `GET /v2/skills/:name/:version/:id`, the response
is the skill's Markdown as published. An unknown id answers 404.

**5.3** Both reads are anonymous and cacheable like `/v2/blob`. They serve
from the stored rows and members, never by re-reading the archive.

## 6. Lifecycle and backfill

**6.1** When a version is published, its skills are indexed in the same
transaction that records the version, so the index is complete by
construction.

**6.2** When a version is retracted or removed, its rows and served members
go with it.

**6.3** When the index is introduced, a backfill reads every stored archive
once, like the class-index backfill, and reports the archives it could not
read rather than skipping them silently.

## 7. Keywords

**7.1** When a publish carries `details.keywords` from the manifest, they
land in the `keywords` column and take part in ranking under §4.3. The
manifest side is `library-discovery-spec.md` §5.

## 8. Acceptance criteria

**8.1** After cloud's next publish, `q=identity` ranks `dev.cajeta.cloud`
first and the hit carries the `cloud-identity` skill.

**8.2** An archive with a corrupt `skills/index.json` is refused at upload
with a message naming the member.

**8.3** `GET /v2/skills/dev.cajeta.http/0.3.1` returns the same bytes as the
member inside the resolved archive.

**8.4** The backfill over the live registry completes with every archive
accounted for, indexed or named as unreadable.
