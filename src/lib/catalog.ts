// D1 query helpers. Routes call these — no raw SQL in route handlers (§8).
import type { Env, PackageRow, VersionRow, BlobRow } from '../types';
import { compareVersions } from './semver';
import { toCanonical } from './sha';

export async function getPackage(env: Env, name: string): Promise<PackageRow | null> {
  return env.DB.prepare('SELECT * FROM packages WHERE name = ?')
    .bind(name)
    .first<PackageRow>();
}

export async function getVersionStrings(env: Env, name: string): Promise<string[]> {
  const res = await env.DB.prepare('SELECT version FROM versions WHERE name = ?')
    .bind(name)
    .all<{ version: string }>();
  return (res.results ?? []).map((r) => r.version).sort(compareVersions);
}

export async function getVersion(
  env: Env,
  name: string,
  version: string,
): Promise<VersionRow | null> {
  return env.DB.prepare('SELECT * FROM versions WHERE name = ? AND version = ?')
    .bind(name, version)
    .first<VersionRow>();
}

export async function getBlobRow(env: Env, sha: string): Promise<BlobRow | null> {
  return env.DB.prepare('SELECT * FROM blobs WHERE sha256 = ?')
    .bind(toCanonical(sha))
    .first<BlobRow>();
}

export async function getTransparency(env: Env, sha: string) {
  return env.DB.prepare(
    'SELECT * FROM transparency_log WHERE sha256 = ? ORDER BY seq DESC LIMIT 1',
  )
    .bind(toCanonical(sha))
    .first<{
      seq: number;
      sha256: string;
      signed_at: string;
      log_entry_signature: string;
      log_entry_key_id: string;
    }>();
}

export interface PublishInput {
  name: string;
  version: string;
  sha: string; // canonical "sha256:<hex>"
  size: number;
  r2Key: string;
  manifestJson: string;
  readme: string;
  keywords: string;
  description: string;
  namespace: string | null;
  keyId: string | null;
  signature: string | null;
  now: string; // ISO 8601
}

/**
 * Persist a publish atomically (D1 batch): package upsert, version row, blob
 * pointer, latest_version recompute, transparency-log append. Assumes the
 * caller already verified (name,version) does not exist.
 */
export async function recordPublish(env: Env, p: PublishInput): Promise<void> {
  const existing = await getVersionStrings(env, p.name);
  const allVersions = [...existing, p.version];
  allVersions.sort(compareVersions);
  const latest = allVersions[allVersions.length - 1];

  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO packages (name, namespace, description, keywords, latest_version, created_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           description = excluded.description,
           keywords = excluded.keywords,
           namespace = COALESCE(excluded.namespace, packages.namespace),
           latest_version = excluded.latest_version`,
      )
      .bind(p.name, p.namespace, p.description, p.keywords, latest, p.now),
    env.DB
      .prepare(
        `INSERT INTO versions
           (name, version, sha256, manifest_json, readme, retracted, retracted_reason, key_id, published_at)
         VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .bind(p.name, p.version, p.sha, p.manifestJson, p.readme, p.keyId, p.now),
    env.DB
      .prepare(
        `INSERT INTO blobs (sha256, size, r2_key, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(sha256) DO NOTHING`,
      )
      .bind(p.sha, p.size, p.r2Key, p.now),
    env.DB
      .prepare(
        `INSERT INTO transparency_log (sha256, signed_at, log_entry_signature, log_entry_key_id)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(p.sha, p.now, p.signature ?? '', p.keyId ?? ''),
  ]);
}

export interface PackageListItem {
  name: string;
  description: string;
  latest_version: string | null;
  versions_count: number;
}

/** List all packages (catalog index for the Browse / library-API page). */
export async function listPackages(
  env: Env,
  page: number,
  hits: number,
): Promise<{ packages: PackageListItem[]; nbPackages: number }> {
  const offset = page * hits;
  const rows = await env.DB.prepare(
    `SELECT p.name AS name,
            p.description AS description,
            p.latest_version AS latest_version,
            (SELECT count(*) FROM versions v WHERE v.name = p.name) AS versions_count
       FROM packages p
      ORDER BY p.name ASC
      LIMIT ? OFFSET ?`,
  )
    .bind(hits, offset)
    .all<PackageListItem>();
  const countRow = await env.DB.prepare('SELECT count(*) AS n FROM packages').first<{
    n: number;
  }>();
  return { packages: rows.results ?? [], nbPackages: countRow?.n ?? 0 };
}

export async function setRetracted(
  env: Env,
  name: string,
  version: string,
  reason: string,
): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE versions SET retracted = 1, retracted_reason = ? WHERE name = ? AND version = ?',
  )
    .bind(reason, name, version)
    .run();
  return (res.meta.changes ?? 0) > 0;
}
