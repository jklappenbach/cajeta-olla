import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { CaramelCube } from '../components/Logo';
import { SearchBar } from '../components/SearchBar';
import { PackageCard } from '../components/PackageCard';
import { api, type PackageListItem } from '../lib/api';

export function Home() {
  const nav = useNavigate();
  const [popular, setPopular] = useState<PackageListItem[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    api
      .packages(0, 6)
      .then((r) => {
        if (!live) return;
        setPopular(r.packages);
        setTotal(r.nbPackages);
      })
      .catch(() => live && setPopular([]));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="container">
      <section className="hero">
        <CaramelCube className="cube" />
        <p className="eyebrow">The Cajeta package registry</p>
        <h1>Find &amp; install Cajeta packages</h1>
        <p className="lede">
          A warm, content-addressed home for Cajeta libraries — search the
          catalog, read the docs, and let <code>cajeta build</code> pull them in.
        </p>
        <SearchBar
          autoFocus
          onSubmit={(q) => nav(`/search?q=${encodeURIComponent(q)}`)}
        />
        <p className="result-meta" style={{ marginTop: 16 }}>
          {total != null ? `${total} packages · ` : ''}
          <Link to="/packages">browse every library →</Link>
        </p>
      </section>

      {popular && popular.length > 0 && (
        <section className="section featured">
          <p className="eyebrow">Popular libraries</p>
          <h2 style={{ marginBottom: 18 }}>Fresh from the olla</h2>
          {popular.map((p) => (
            <PackageCard
              key={p.name}
              name={p.name}
              version={p.latest_version}
              description={p.description}
              keywords={p.keywords}
            />
          ))}
        </section>
      )}

      <section className="section">
        <div className="how">
          <div className="step">
            <span className="n">01 · Publish</span>
            <h3>Ship a library</h3>
            <p className="pkg-desc">
              Sign your <code>.cja</code> and <code>cajeta publish</code> it.
              Olla verifies the Ed25519 signature and provenance.
            </p>
          </div>
          <div className="step">
            <span className="n">02 · Resolve</span>
            <h3>Declare a dep</h3>
            <p className="pkg-desc">
              Add it to <code>settings.dependencies</code>; <code>cajeta build</code>{' '}
              resolves &amp; downloads it (with transitive deps) from here.
            </p>
          </div>
          <div className="step">
            <span className="n">03 · Browse</span>
            <h3>Explore the docs</h3>
            <p className="pkg-desc">
              Search by name or keyword, read each library’s API, and copy a
              shareable link. <Link to="/packages">Start browsing →</Link>
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
