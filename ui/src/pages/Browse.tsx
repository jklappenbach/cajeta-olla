import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PackageListItem } from '../lib/api';

export function Browse() {
  const [pkgs, setPkgs] = useState<PackageListItem[] | null>(null);
  const [nb, setNb] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .packages()
      .then((r) => {
        if (!live) return;
        setPkgs(r.packages);
        setNb(r.nbPackages);
      })
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, []);

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
      {pkgs && pkgs.length === 0 && (
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
          <p className="result-meta">{nb} packages</p>
          {pkgs.map((p) => (
            <Link key={p.name} to={`/p/${encodeURIComponent(p.name)}`} className="card">
              <div className="pkg-name">
                {p.name}
                {p.latest_version && <span className="badge">{p.latest_version}</span>}
                <span className="badge">
                  {p.versions_count} {p.versions_count === 1 ? 'version' : 'versions'}
                </span>
              </div>
              <div className="pkg-desc">{p.description || 'No description.'}</div>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
