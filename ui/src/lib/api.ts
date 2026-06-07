// Registry API client. In dev these paths are proxied to the Worker
// (wrangler dev :8787); in prod they're same-origin.

export interface SearchHit {
  name: string;
  version: string | null;
  description: string;
  score: number;
}
export interface SearchResult {
  hits: SearchHit[];
  page: number;
  nbHits: number;
}
export interface PackageDetail {
  name: string;
  description: string;
  namespace: string | null;
  keywords: string;
  latest_version: string | null;
  versions: string[];
}
export interface PackageListItem {
  name: string;
  description: string;
  latest_version: string | null;
  versions_count: number;
}
export interface ResolveMeta {
  name: string;
  version: string;
  sha256: string;
  size: number;
  deps: { name: string; version: string }[];
  'published-at': string;
  retracted: boolean;
  'retracted-reason'?: string;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  search: (q: string, page = 0, hits = 20) =>
    getJson<SearchResult>(
      `/v2/search?q=${encodeURIComponent(q)}&page=${page}&hits=${hits}`,
    ),
  packages: (page = 0, hits = 50) =>
    getJson<{ packages: PackageListItem[]; nbPackages: number }>(
      `/v2/packages?page=${page}&hits=${hits}`,
    ),
  package: (name: string) =>
    getJson<PackageDetail>(`/v2/package/${encodeURIComponent(name)}`),
  resolve: (name: string, version = '*') =>
    getJson<ResolveMeta>(
      `/v2/resolve?name=${encodeURIComponent(name)}&version=${encodeURIComponent(version)}`,
    ),
};
