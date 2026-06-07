// Semver constraint matching, mirroring the build tool's C++ resolver
// (src/cajeta/buildtool/Resolver.cpp) so server-side resolution agrees with
// the client's MVS. Supported constraint forms:
//   - exact     "1.2.3"
//   - wildcard  "1.2.*", "1.*", "*"
//   - range     ">=1.2.0" "<2.0.0" ">1.0" "<=3" "=1.2.3"
//   - AND-combo  ">=1.2.0,<2.0.0"  (comma-joined; all atoms must hold)

function segments(v: string): number[] {
  return v.split('.').map((s) => {
    const n = parseInt(s, 10);
    return Number.isNaN(n) ? 0 : n;
  });
}

/** <0 if a<b, 0 if equal, >0 if a>b. Numeric, segment-wise, zero-padded. */
export function compareVersions(a: string, b: string): number {
  const sa = segments(a);
  const sb = segments(b);
  const len = Math.max(sa.length, sb.length);
  for (let i = 0; i < len; i++) {
    const d = (sa[i] ?? 0) - (sb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function satisfiesAtom(version: string, atom: string): boolean {
  atom = atom.trim();
  if (atom === '' || atom === '*') return true;

  // Wildcard: prefix-of-segments match ("1.2.*" matches "1.2.7").
  if (atom.endsWith('.*') || atom.endsWith('*')) {
    const prefix = atom.replace(/\.?\*+$/, '');
    if (prefix === '') return true;
    const pv = segments(prefix);
    const vv = segments(version);
    for (let i = 0; i < pv.length; i++) {
      if ((vv[i] ?? 0) !== pv[i]) return false;
    }
    return true;
  }

  // Range operators.
  const m = atom.match(/^(>=|<=|>|<|=)?\s*([0-9].*)$/);
  if (!m) return false;
  const op = m[1] ?? '=';
  const cmp = compareVersions(version, m[2]);
  switch (op) {
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    case '=': return cmp === 0;
    default: return false;
  }
}

export function versionSatisfies(version: string, constraint: string): boolean {
  return constraint
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .every((atom) => satisfiesAtom(version, atom));
}

/**
 * Pick the resolution from `available` for a `?version=` parameter that may be
 * an exact version OR a constraint. Exact match wins; otherwise the HIGHEST
 * satisfying version is returned (the registry advertises the newest match;
 * the client re-runs MVS locally to pick its own lowest-satisfying pin).
 */
export function pickVersion(available: string[], request: string): string | null {
  if (available.includes(request)) return request;
  const matches = available.filter((v) => versionSatisfies(v, request));
  if (matches.length === 0) return null;
  matches.sort(compareVersions);
  return matches[matches.length - 1];
}
