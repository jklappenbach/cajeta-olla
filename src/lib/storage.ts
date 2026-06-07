// R2 blob storage — content-addressed at blob/<hex>. R2 is the bytes; the
// `blobs` D1 table is the pointer index (see catalog.ts).
import type { Env } from '../types';
import { toHex } from './sha';

export function blobKey(sha: string): string {
  return 'blob/' + toHex(sha);
}

export async function putBlob(env: Env, sha: string, bytes: ArrayBuffer): Promise<void> {
  await env.BLOBS.put(blobKey(sha), bytes, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
}

export async function getBlob(env: Env, sha: string): Promise<R2ObjectBody | null> {
  return env.BLOBS.get(blobKey(sha));
}

/** Range-aware fetch for resumable installs (§13). */
export async function getBlobRange(
  env: Env,
  sha: string,
  range?: R2Range,
): Promise<R2ObjectBody | null> {
  return env.BLOBS.get(blobKey(sha), range ? { range } : undefined);
}

export async function headBlob(env: Env, sha: string): Promise<R2Object | null> {
  return env.BLOBS.head(blobKey(sha));
}
