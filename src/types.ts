// Worker bindings + shared row shapes.

export interface Env {
  // Catalog (metadata system of record).
  DB: D1Database;
  // Artifact bytes, content-addressed at blob/<hex>.
  BLOBS: R2Bucket;
  // Static assets binding — the built React UI (ui/dist), served same-origin.
  ASSETS: Fetcher;

  // Vars (wrangler.toml [vars] / secrets).
  CAPABILITY_TTL_SECONDS?: string;
  WELL_KNOWN_BUNDLES?: string; // comma-separated "<name>@<version>"
  SEARCH_PROVIDER?: string; // "d1" | "algolia"
  ALLOW_UNSIGNED?: string; // "1" enables unsigned dev publishes
  MIRRORS?: string; // JSON array of {url, region}
  BUNDLE_ZSTD_LEVEL?: string; // bundle compression level (default 19)

  // Transparency-log signing (§15): the registry signs each log entry with
  // its own Ed25519 log key. PEM (PKCS#8) + an opaque key id. Secrets in prod.
  LOG_SIGNING_KEY_PEM?: string;
  LOG_SIGNING_KEY_ID?: string;
  // The repository ROOT public key (publisher-trust §3.1). PUBLIC material,
  // so a var rather than a secret — olla never holds the private half, and an
  // admin credential that could produce a root signature would forge any
  // organization's document.
  CAJETA_ROOT_KEY_PEM?: string;
  CAJETA_ROOT_KEY_ID?: string;
  // "1" advertises capabilities.revocation. Off until /v2/revocations is
  // re-issued on a schedule — it fails CLOSED for every client at once.
  ADVERTISE_REVOCATION?: string;
  // The DELEGATED key that signs release metadata (§2.6). A SECRET — unlike
  // the root, this one is online because it signs on every publish, which is
  // the whole point of delegating: a compromise here forges release metadata
  // and nothing else.
  RELEASE_SIGNING_KEY_PEM?: string;
  RELEASE_SIGNING_KEY_ID?: string;
  // Require a verified namespace proof on publish (off in dev).
  REQUIRE_NAMESPACE?: string; // "1" enforces

  // Algolia search provider (§12). Selected when SEARCH_PROVIDER=algolia and
  // these are set; otherwise the built-in D1 FTS5 provider is used. The admin
  // key (indexing) is a secret; the search key is optional (defaults to admin).
  ALGOLIA_APP_ID?: string;
  ALGOLIA_API_KEY?: string; // admin key — indexing + reindex
  ALGOLIA_SEARCH_KEY?: string; // optional search-only key
  ALGOLIA_INDEX?: string; // default "packages"
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
  signature: string | null; // publisher's detached sig, base64
  attestation: string | null; // in-toto/SLSA provenance JSON
  /** The signed release envelope, verbatim (§2.6). Null when unsigned. */
  signed_metadata: string | null;
  /** Authenticated principal that published it (§4.5). */
  organization: string | null;
}

export interface TrustKeyRow {
  key_id: string;
  public_key: string; // PEM SPKI
  principal: string | null;
  fingerprint: string | null;
  created_at: string;
}

export interface BlobRow {
  sha256: string; // "sha256:<hex>"
  size: number;
  r2_key: string;
  created_at: string;
}
