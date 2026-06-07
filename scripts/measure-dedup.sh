#!/usr/bin/env bash
# §14 acceptance — cross-library dedup. Publishes two packages that share a
# large common section, bundles them, and compares the bundle size against the
# sum of each member compressed independently (zstd -19). The solid single-
# frame stream should match the shared section across members, so the bundle is
# meaningfully smaller. Gate: bundle / Σ(individual) < 0.95.
#
# Requires: a running Olla (npm run dev) + `zstd`, `curl`, `sha256sum`.
# BASE overrides the target (default http://localhost:8787).
set -euo pipefail

BASE="${BASE:-http://localhost:8787}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Shared section (incompressible on its own → makes the dedup win unambiguous)
# plus a small unique tail per member.
head -c 262144 /dev/urandom > "$TMP/shared"
cat "$TMP/shared" <(head -c 4096 /dev/urandom) > "$TMP/a.cja"
cat "$TMP/shared" <(head -c 4096 /dev/urandom) > "$TMP/b.cja"

publish() { # name version file
  local name="$1" ver="$2" file="$3"
  local sha="sha256:$(sha256sum "$file" | cut -d' ' -f1)"
  curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/v2/publish" \
    -F "archive=@$file;filename=$name-$ver.cja;type=application/octet-stream" \
    -F "metadata={\"name\":\"$name\",\"version\":\"$ver\",\"sha256\":\"$sha\"}" \
    -F "manifest={\"details\":{\"name\":\"$name\",\"version\":\"$ver\",\"cajeta-lang-version\":\"1.0\"},\"settings\":{\"description\":\"dedup probe\"}}"
}

echo "publishing dedup.a / dedup.b …"
publish "dedup.a" "1.0.0" "$TMP/a.cja" | grep -qE '201|409' && echo "  a ok" || { echo "  a FAILED"; exit 1; }
echo
publish "dedup.b" "1.0.0" "$TMP/b.cja" | grep -qE '201|409' && echo "  b ok" || { echo "  b FAILED"; exit 1; }
echo

# Bundle both (no transitive deps).
curl -s -X POST "$BASE/v2/bundle" -H 'Content-Type: application/cajeta-bundle-request+json' \
  -d '{"have":[],"want":[{"name":"dedup.a","version":"1.0.0"},{"name":"dedup.b","version":"1.0.0"}],"transitive":false,"format":"tar.zst"}' \
  -o "$TMP/bundle.tzst"

bundle_size=$(wc -c < "$TMP/bundle.tzst")
ia=$(zstd -19 -c "$TMP/a.cja" 2>/dev/null | wc -c)
ib=$(zstd -19 -c "$TMP/b.cja" 2>/dev/null | wc -c)
sum=$((ia + ib))
ratio=$(python3 -c "print(f'{$bundle_size/$sum:.3f}')")

echo "bundle (solid tar.zst, 2 members):  $bundle_size bytes"
echo "Σ individual zstd -19:              $sum bytes  (a=$ia, b=$ib)"
echo "ratio bundle/Σindividual:           $ratio   (gate < 0.95)"
python3 -c "import sys; sys.exit(0 if $bundle_size/$sum < 0.95 else 1)" \
  && echo "✓ cross-library dedup: bundle beats the sum" \
  || { echo "✗ no dedup advantage"; exit 1; }

echo
echo "note: real .cja archives are pre-compressed containers, so cross-member"
echo "matches only surface when members are ingested store-only (§14) — that"
echo "is an archive-format/build-tool concern, not the registry's."
