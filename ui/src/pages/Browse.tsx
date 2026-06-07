import { useEffect, useState } from 'react';
import { api, type PackageListItem } from '../lib/api';
import { PackageCard } from '../components/PackageCard';
import { Pagination } from '../components/Pagination';

const HITS = 24;

export function Browse() {
  const [pkgs, setPkgs] = useState<PackageListItem[] | null>(null);
  const [nb, setNb] = useState(0);
  const [page, setPage] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setPkgs(null);
    api
      .packages(page, HITS)
      .then((r) => {
        if (!live) return;
        setPkgs(r.packages);
        setNb(r.nbPackages);
      })
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [page]);

  return (
    <div className="container section">
      <p className="eyebrow">Library APIs</p>
      <h1>Browse the catalog</h1>
      {error && (
        <div className="empty">
          <span className="clay">⚠️</span>
          <p>{error}</p>
        </div>
      )}
      {!pkgs && !error && <div className="spinner">Loading…</div>}
      {pkgs && pkgs.length === 0 && page === 0 && (
        <div className="empty">
          <span className="clay">🫙</span>
          <h3>No packages published yet.</h3>
          <p>
            Publish one with <code>cajeta publish</code> (or seed the dev
            registry) and it’ll show up here.
          </p>
        </div>
      )}
      {pkgs && pkgs.length > 0 && (
        <>
          <p className="result-meta">
            {nb} packages · showing {page * HITS + 1}–{page * HITS + pkgs.length}
          </p>
          {pkgs.map((p) => (
            <PackageCard
              key={p.name}
              name={p.name}
              version={p.latest_version}
              description={p.description}
              keywords={p.keywords}
              badges={
                <span className="badge">
                  {p.versions_count} {p.versions_count === 1 ? 'version' : 'versions'}
                </span>
              }
            />
          ))}
          <Pagination page={page} nb={nb} hits={HITS} onPage={setPage} />
        </>
      )}
    </div>
  );
}
