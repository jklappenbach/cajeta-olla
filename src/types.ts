// Worker bindings + shared row shapes.

export interface Env {
  // Catalog (metadata system of record).
  DB: D1Database;
  // Artifact bytes, content-addressed at blob/<hex>.
  BLOBS: R2Bucket;

  // Vars (wrangler.toml [vars] / secrets).
  CAPABILITY_TTL_SECONDS?: string;
  WELL_KNOWN_BUNDLES?: string; // comma-separated "<name>@<version>"
  SEARCH_PROVIDER?: string; // "d1" | "algolia"
  ALLOW_UNSIGNED?: string; // "1" enables unsigned dev publishes
  MIRRORS?: string; // JSON array of {url, region}
}

export interface PackageRow {
  name: string;
  namespace: string | null;
  description: string;
  keywords: string;
  latest_version: string | null;
  created_at: string;
}

export interface VersionRow {
  name: string;
  version: string;
  sha256: string; // "sha256:<hex>"
  manifest_json: string;
  readme: string;
  retracted: number;
  retracted_reason: string | null;
  key_id: string | null;
  published_at: string;
}

export interface BlobRow {
  sha256: string; // "sha256:<hex>"
  size: number;
  r2_key: string;
  created_at: string;
}
