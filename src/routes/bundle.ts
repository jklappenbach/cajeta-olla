// POST /v2/bundle, POST /v2/lockfile-diff (§14). Baseline tar.zst: a solid
// ustar archive of the requested closure's `<sha256-hex>.cja` members plus a
// `bundle.json` index, zstd-compressed. `have` digests are short-circuited
// (blob-level dedup); `transitive:true` expands deps via each member's
// manifest and pins them. The `supercompress` path (dictionary / CDC) is not
// implemented, so a non-tar.zst `format` is rejected.
import { Hono } from 'hono';
import type { Env } from '../types';
import { getVersionStrings, getVersion } from '../lib/catalog';
import { getBlob } from '../lib/storage';
import { pickVersion } from '../lib/semver';
import { parseManifestMeta } from '../lib/manifest';
import { toHex } from '../lib/sha';
import { writeTarZstd, type TarEntry } from '../lib/bundle-codec';
import { jsonError } from '../lib/http';

export const bundle = new Hono<{ Bindings: Env }>();

interface Want {
  name: string;
  version: string;
}
interface Resolved {
  name: string;
  version: string;
  sha: string; // canonical
  hex: string;
  manifestJson: string;
}

async function resolveOne(env: Env, name: string, request: string): Promise<Resolved | null> {
  const available = await getVersionStrings(env, name);
  if (available.length === 0) return null;
  const chosen = pickVersion(available, request || '*');
  if (!chosen) return null;
  const row = await getVersion(env, name, chosen);
  if (!row) return null;
  return {
    name,
    version: chosen,
    sha: row.sha256,
    hex: toHex(row.sha256),
    manifestJson: row.manifest_json,
  };
}

// Expand the requested wants into a deduped closure (by package name). When
// `transitive`, walk each member's manifest dependencies breadth-first.
async function resolveClosure(
  env: Env,
  wants: Want[],
  transitive: boolean,
): Promise<{ closure: Resolved[]; missing: string[] }> {
  const byName = new Map<string, Resolved>();
  const missing: string[] = [];
  const queue: Want[] = [...wants];

  while (queue.length) {
    const w = queue.shift()!;
    if (byName.has(w.name)) continue;
    const r = await resolveOne(env, w.name, w.version);
    if (!r) {
      missing.push(`${w.name}@${w.version || '*'}`);
      continue;
    }
    byName.set(r.name, r);
    if (transitive) {
      for (const dep of parseManifestMeta(r.manifestJson).dependencies) {
        if (!byName.has(dep.name)) queue.push({ name: dep.name, version: dep.version });
      }
    }
  }
  return { closure: [...byName.values()], missing };
}

bundle.post('/v2/bundle', async (c) => {
  let body: { have?: string[]; want?: Want[]; transitive?: boolean; format?: string };
  try {
    body = await c.req.json();
  } catch {
    return jsonError(c, 400, 'expected JSON body');
  }
  const format = body.format ?? 'tar.zst';
  if (format !== 'tar.zst') {
    return jsonError(c, 400, `unsupported format '${format}' (only tar.zst)`, {
      code: 'UNSUPPORTED_FORMAT',
    });
  }
  const wants = body.want ?? [];
  if (wants.length === 0) return jsonError(c, 400, "empty 'want' set");

  const have = new Set((body.have ?? []).map(toHex));
  const { closure, missing } = await resolveClosure(c.env, wants, body.transitive ?? true);
  if (missing.length) {
    return jsonError(c, 404, `unresolved: ${missing.join(', ')}`, { code: 'UNRESOLVED' });
  }

  const entries: TarEntry[] = [];
  const indexEntries: { name: string; version: string; sha256: string }[] = [];
  const omitted: string[] = [];

  for (const r of closure) {
    if (have.has(r.hex)) {
      omitted.push(r.name);
      continue;
    }
    const obj = await getBlob(c.env, r.sha);
    if (!obj) return jsonError(c, 500, `blob bytes missing for ${r.name}@${r.version}`);
    entries.push({ name: `${r.hex}.cja`, data: new Uint8Array(await obj.arrayBuffer()) });
    indexEntries.push({ name: r.name, version: r.version, sha256: r.sha });
  }

  const indexJson = JSON.stringify({ entries: indexEntries, omitted });
  entries.push({ name: 'bundle.json', data: new TextEncoder().encode(indexJson) });

  const tarZst = await writeTarZstd(entries);
  return new Response(tarZst, {
    status: 200,
    headers: {
      'Content-Type': 'application/x-tar-zstd',
      'Content-Length': String(tarZst.length),
    },
  });
});

// The client sends only the two lockfile digests and expects the server to
// have snapshotted them. We don't snapshot lockfiles, so we return the
// protocol-sanctioned 404 — the client then falls back to /v2/bundle.
bundle.post('/v2/lockfile-diff', (c) =>
  jsonError(c, 404, 'no snapshot for old lockfile sha256 — fall back to /v2/bundle', {
    code: 'NO_SNAPSHOT',
  }),
);
