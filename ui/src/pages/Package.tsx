import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { CopyButton } from '../components/CopyButton';
import { api, type PackageDetail, type ResolveMeta } from '../lib/api';

export function Package() {
  const { name = '' } = useParams();
  const [pkg, setPkg] = useState<PackageDetail | null>(null);
  const [meta, setMeta] = useState<ResolveMeta | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setError(null);
    setPkg(null);
    setMeta(null);
    api
      .package(name)
      .then((p) => {
        if (!live) return;
        setPkg(p);
        return api.resolve(name, p.latest_version ?? '*').then((m) => live && setMeta(m));
      })
      .catch((e) => live && setError(String(e.message ?? e)));
    return () => {
      live = false;
    };
  }, [name]);

  if (error) {
    return (
      <div className="container section">
        <div className="empty">
          <span className="clay">🫙</span>
          <h3>{error}</h3>
          <p>
            <Link to="/packages">Browse all packages →</Link>
          </p>
        </div>
      </div>
    );
  }
  if (!pkg) return <div className="spinner">Loading…</div>;

  const latest = pkg.latest_version ?? pkg.versions[0];
  const shareUrl = typeof window !== 'undefined' ? window.location.href : '';
  const installCmd = `cajeta add ${pkg.name}`;
  const keywords = pkg.keywords.split(/[\s,]+/).filter(Boolean);

  return (
    <div className="container section">
      <div className="detail-head">
        <p className="eyebrow">Cajeta library</p>
        <h1>
          {pkg.name}
          {latest && <span className="badge">{latest}</span>}
          {meta?.retracted && <span className="badge retracted">retracted</span>}
        </h1>
        <p className="lede" style={{ margin: 0 }}>
          {pkg.description || 'No description provided.'}
        </p>
        <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
          {/* The result-detail → copy-link step of the docs workflow. */}
          <CopyButton text={shareUrl} label="🔗 Copy link" className="on-cream" />
        </div>
      </div>

      <h3>Install</h3>
      <div className="install">
        <CopyButton text={installCmd} label="Copy" className="copy" />
        <code>$ {installCmd}</code>
      </div>
      <p className="result-meta">
        …or add <code>"{pkg.name}": "{latest}"</code> to{' '}
        <code>settings.dependencies</code> in your <code>cajeta.json</code>.
      </p>

      <dl className="kv">
        {latest && (
          <>
            <dt>Latest</dt>
            <dd>{latest}</dd>
          </>
        )}
        {meta && (
          <>
            <dt>Digest</dt>
            <dd className="mono" style={{ wordBreak: 'break-all' }}>
              {meta.sha256}
            </dd>
            <dt>Size</dt>
            <dd>{meta.size} bytes</dd>
            <dt>Published</dt>
            <dd>{meta['published-at']}</dd>
          </>
        )}
        {pkg.namespace && (
          <>
            <dt>Namespace</dt>
            <dd>{pkg.namespace}</dd>
          </>
        )}
      </dl>

      {keywords.length > 0 && (
        <p>
          {keywords.map((k) => (
            <span key={k} className="badge" style={{ marginLeft: 0, marginRight: 8 }}>
              {k}
            </span>
          ))}
        </p>
      )}

      {meta && meta.deps.length > 0 && (
        <>
          <h3>Dependencies</h3>
          <ul className="versions">
            {meta.deps.map((d) => (
              <li key={d.name}>
                <Link to={`/p/${encodeURIComponent(d.name)}`}>{d.name}</Link>
                <span className="badge">{d.version || '*'}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Versions</h3>
      <ul className="versions">
        {pkg.versions.map((v) => (
          <li key={v}>
            <span className="mono">{v}</span>
            {v === latest && <span className="badge">latest</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
