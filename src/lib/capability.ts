// Capability document (§9) + the per-response capability header.
import type { Env } from '../types';

export const CAPABILITY_VERSION = '1';
export const CAPABILITY_HEADER = 'Cajeta-Capability-Version';

export interface CapabilityDoc {
  capabilities: {
    v1: boolean;
    v2: boolean;
    bundle: boolean;
    'lockfile-diff': boolean;
    supercompress: boolean;
    'transparency-log': boolean;
    'well-known-bundles': string[];
  };
  mirrors?: { url: string; region: string }[];
  'ttl-seconds': number;
}

export function capabilityDoc(env: Env): CapabilityDoc {
  const wellKnown = (env.WELL_KNOWN_BUNDLES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  let mirrors: { url: string; region: string }[] | undefined;
  if (env.MIRRORS) {
    try {
      mirrors = JSON.parse(env.MIRRORS);
    } catch {
      mirrors = undefined;
    }
  }

  const doc: CapabilityDoc = {
    capabilities: {
      v1: true,
      v2: true,
      // Baseline tar.zst bundling (§14): solid ustar + zstd over content-
      // addressed members, `have`/`want`/`transitive` honored.
      bundle: true,
      // lockfile-diff needs server-side lockfile snapshots (not yet kept), so
      // the endpoint returns 404→fall-back-to-bundle; don't advertise it live.
      'lockfile-diff': false,
      // supercompress (dictionary/CDC) is a §14 enhancement over baseline.
      supercompress: false,
      'transparency-log': true,
      'well-known-bundles': wellKnown,
    },
    'ttl-seconds': parseInt(env.CAPABILITY_TTL_SECONDS ?? '3600', 10),
  };
  if (mirrors && mirrors.length) doc.mirrors = mirrors;
  return doc;
}
