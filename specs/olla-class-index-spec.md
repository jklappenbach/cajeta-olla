# olla-class-index — find the library that holds a class

## 1. Definition

**1.1** Every published library is scanned for the classes it contains, and
each class's fully-qualified name is indexed against that library. Searching
for a class name returns the libraries that hold it.

**1.2** The problem: a developer knows the class and not the package. Today
olla's search covers package name, description, keywords and readme, so
`cajeta.text.Shaper` finds a library only if someone happened to write that
string in prose. The archive that was published knows the answer exactly and
nothing asks it.

**1.3** It is cheap, because the archive already carries a manifest of
itself. A `.cja` ends with a trailing index — `entry_count`, then per entry a
name, an offset and a size — and the 32-byte header holds that index's offset
and length. So the class list costs three small ranged reads (header,
manifest, trailing index) and never touches an entry payload or decompresses
a byte of bitcode. Scanning does not scale with archive size.

**1.3.1** The `.cja` header comment in `CajetaArchive.h` states that v1 writes
no trailing index. That comment is stale: `writeTo()` always writes one and
patches the offset into the header afterwards. This spec is written against
the writer, which was read; anything derived from the comment would be wrong.

**1.4 Scope.** Extracting class names from a published archive; an index
keyed by package, version and class; class names as a matched field in the
existing search; the lifecycle that keeps the index true as versions are
published, retracted and removed; and a backfill over what is already
published.

**1.5 Non-goals.**

**1.5.1** Parsing bitcode. The entry name carries the fully-qualified name;
opening LLVM bitcode in a Worker would buy nothing.

**1.5.2** Members. Methods, fields and signatures are out of scope — this
answers "which library holds this class", not "which library has this
method". The index is designed so members could be added later without
reshaping it.

**1.5.3** Cross-version diffing ("which release introduced this class"). The
data supports the question; no endpoint answers it here.

**1.5.4** A new search backend. This works with the D1 FTS5 provider and with
Algolia, and changes neither.

**1.6 Constraint — publishing now depends on the scanner.** An archive that
cannot be scanned is refused at upload (§6.1), which keeps the index complete
by construction and means a scanner defect is a publish outage. Two things
follow, and they are requirements rather than observations: the scan is
bounded work on bytes already in memory at publish time (§1.3), and the
scanner is tested against archives the real compiler produced (§7.1).

## 2. Reading the class list from an archive

**2.1** When an archive is scanned, its 32-byte header is read first, and an
archive whose magic is not `CAJETA01` is not scanned.

**2.2** When the header's `index_offset` is zero, the archive carries no
trailing index and is not scanned. Enumerating entries by walking payloads
would make the cost proportional to the archive, which is the property §1.3
exists to keep.

**2.3** When the trailing index is read, every entry's name is taken from it.
The index holds names, offsets and sizes; it does not hold the per-entry
origin and kind tags, which sit in the entry bodies.

**2.4** A class name is derived from an entry name by dropping the extension
and replacing `/` with `.`, so `cajeta/lang/String.bc` is
`cajeta.lang.String`.

**2.5** Entries ending `.bc` and `.cajeta` name classes; every other entry
does not. Both extensions can name the same class, so a class appears in the
index once.

**2.5.1** This reads the kind off the entry NAME rather than the kind tag in
the entry body, because the trailing index does not carry the tag and
fetching it per entry would cost a ranged read each. The dependency is
recorded here so that a format change adding a non-class `.bc` entry is
understood to break this rule.

**2.6** When the archive's manifest says its kind is not the library form,
the archive is not class-indexed. A `.cja` carries only the project's own
classes — stdlib and dependencies are stripped — while an uber archive mixes
in the stdlib and every transitive dependency. Indexing one would enter
`cajeta.lang.String` against a library that merely embeds it, and one such
archive makes a search for any stdlib class useless.

**2.7** When an entry sits under `deps/`, it is not indexed. This is the same
refusal as §2.6 at entry granularity, and it holds even if an uber archive
reaches the scanner some other way.

**2.8** When the header's flags mark the manifest compressed, it is
decompressed to be read. Entry payloads are never decompressed, compressed or
not — only their names are used, and names live uncompressed in the trailing
index.

**2.9** When an archive is malformed part-way through — a truncated index, a
name length running past the end — the entries read so far are discarded and
the archive is unscannable (§6.1). A partial class list is worse than none: it
reads as a complete answer, and nothing downstream can tell it from one.

## 3. The index

**3.1** The index holds one row per package, version and class name. A
library's classes are recorded against the exact version they were found in.

**3.2** When a class exists in one version and not another, each version's
row set reflects what that version contains. A class dropped at 2.0 is still
found in 1.4, which is the question worth asking when a symbol disappears.

**3.3** Rows are immutable once written, because the version they describe is.
A republish of an existing `(name, version)` is already refused.

**3.4** When a search matches a class, the result names the class it matched
and the version it was found in.

**3.5** When a class is held by several libraries, all of them are returned.
This is ordinary — a name can be genuinely duplicated across publishers, and
concealing that would hide exactly the collision a developer needs to see.

## 4. Search

**4.1** When a query matches a class name held by a library, that library is
a hit on `/v2/search`, alongside matches on name, description, keywords and
readme.

**4.2** When a hit matched on a class, the response carries the matching class
name and the version it came from. A hit that matched only the package's own
fields carries neither.

**4.3** The added field is optional, so a client that does not know about it
is unaffected and no capability flag is needed.

**4.4** When a query is a fully-qualified class name, the libraries holding
that class rank above libraries that merely mention the string in prose. The
exact answer outranks the incidental one.

**4.5** When a search is to be restricted to class names, a query parameter
does it. The default searches everything.

**4.6** Class matching is substring-capable, like the rest of the D1 provider:
`Shaper` finds `cajeta.text.Shaper`.

**4.7** A library's class names do not dilute the ranking of its own
description and readme. Folding hundreds of class names into the package's
existing full-text row would make a large library a large document and skew
every unrelated query against it, so the class text is scored separately.

## 5. Lifecycle

**5.1** When a version is published, it is scanned and its classes are
indexed as part of the publish, in the same transaction. A version is never
stored with its class rows missing, so "indexed" is not a state the catalog
has to track for anything published after this exists.

**5.2** When a version is retracted, its rows stay. Retraction is advisory —
the version still resolves and still installs — and a developer chasing a
class needs to find it in the version that has it.

**5.3** When a version is removed, its rows are deleted. Removal deletes
content, and an index still naming a class in bytes that no longer exist is
an answer that cannot be acted on.

**5.4** When a package is deleted, every version's rows go with it.

**5.5** Everything published before this exists is backfilled by scanning
archives out of blob storage, using ranged reads so a backfill does not
download whole archives.

**5.6** The backfill is resumable and re-runnable, and re-scanning a version
already indexed produces the same rows.

## 6. Failure and limits

**6.1** When an archive cannot be scanned — bad magic, no trailing index,
malformed, or not the library form — the upload is REFUSED, and the response
names which of those it was. An archive olla cannot read is one it cannot
describe, and refusing keeps the index complete by construction rather than
by a reconciliation job that has to be run and watched.

**6.1.1** The cost is real and is accepted deliberately: a defect in the
scanner becomes a failure to publish, on the path that matters most. It is
bounded by keeping the scanner small — it reads a header, a manifest and a
list of names, and parses no payload — and by §7.1, which tests it against
archives the real compiler produced rather than fixtures written to match the
parser.

**6.1.2** A refusal names the archive's own defect, never "indexing failed".
A publisher who cannot publish needs to know whether to rebuild, re-package,
or report a bug in olla.

**6.2** An archive already published when this is built may still be
unscannable, and cannot be refused after the fact. The backfill records those
with the reason and moves on; the catalog reports how many, so a backfill that
silently indexed a third of the repository is visible rather than assumed
complete.

**6.3** When an archive declares more entries than a stated ceiling, or a
name longer than a stated ceiling, it is unscannable and refused per §6.1.
The counts come from the archive, which is data the server did not write and
must not size an allocation from.

**6.4** The number of class rows a single version may contribute is bounded,
and an archive exceeding it is refused rather than truncated — for §2.9's
reason, that a partial list is indistinguishable from a complete one.

## 7. Conformance

**7.1** The scanner is tested against archives built by the real compiler,
not hand-written fixtures, so a format change is caught here rather than in
production.

**7.2** The refusals in §2.6, §2.7 and §6.3 each need a test that they fire
and a test that a well-formed library archive is NOT refused. A scanner that
silently refuses everything indexes nothing and passes every test that only
asserts refusals.
