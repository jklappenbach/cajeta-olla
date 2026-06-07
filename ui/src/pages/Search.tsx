import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SearchBar } from '../components/SearchBar';
import { api, type SearchResult } from '../lib/api';

export function Search() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const q = params.get('q') ?? '';

  const [result, setResult] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.trim()) {
      setResult(null);
      return;
    }
    let live = true;
    setLoading(true);
    setError(null);
    api
      .search(q)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError(String(e.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [q]);

  return (
    <div className="container section">
      <SearchBar
        initial={q}
        autoFocus={!q}
        onSubmit={(next) => nav(`/search?q=${encodeURIComponent(next)}`)}
      />

      {/* State 1 — no query yet: prompt. */}
      {!q.trim() && (
        <div className="empty">
          <span className="clay">🔎</span>
          <p>Type a name or keyword to search the catalog.</p>
        </div>
      )}

      {loading && <div className="spinner">Searching…</div>}
      {error && (
        <div className="empty">
          <span className="clay">⚠️</span>
          <p>{error}</p>
        </div>
      )}

      {/* State 2 — query with zero results: empty-state. */}
      {!loading && q.trim() && result && result.nbHits === 0 && (
        <div className="empty">
          <span className="clay">🫙</span>
          <h3>No packages match “{q}”.</h3>
          <p>
            The olla’s empty for that one. Try a broader term, or{' '}
            <Link to="/packages">browse everything</Link>.
          </p>
        </div>
      )}

      {/* State 3 — results: cards that link to the result detail. */}
      {!loading && result && result.nbHits > 0 && (
        <>
          <p className="result-meta">
            {result.nbHits} {result.nbHits === 1 ? 'result' : 'results'} for “{q}”
          </p>
          {result.hits.map((h) => (
            <Link key={h.name} to={`/p/${encodeURIComponent(h.name)}`} className="card">
              <div className="pkg-name">
                {h.name}
                {h.version && <span className="badge">{h.version}</span>}
              </div>
              <div className="pkg-desc">{h.description || 'No description.'}</div>
            </Link>
          ))}
        </>
      )}
    </div>
  );
}
