import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SearchBar } from '../components/SearchBar';
import { PackageCard } from '../components/PackageCard';
import { Pagination } from '../components/Pagination';
import { api, type SearchResult } from '../lib/api';

const HITS = 20;

export function Search() {
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const q = params.get('q') ?? '';
  const page = Math.max(0, parseInt(params.get('page') ?? '0', 10) || 0);

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
      .search(q, page, HITS)
      .then((r) => live && setResult(r))
      .catch((e) => live && setError(String(e.message ?? e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [q, page]);

  const goPage = (p: number) => setParams({ q, page: String(p) });

  return (
    <div className="container section">
      <SearchBar
        initial={q}
        autoFocus={!q}
        onSubmit={(next) => nav(`/search?q=${encodeURIComponent(next)}`)}
      />

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

      {!loading && result && result.nbHits > 0 && (
        <>
          <p className="result-meta">
            {result.nbHits} {result.nbHits === 1 ? 'result' : 'results'} for “{q}”
          </p>
          {result.hits.map((h) => (
            <PackageCard
              key={h.name}
              name={h.name}
              version={h.version}
              description={h.description}
            />
          ))}
          <Pagination page={page} nb={result.nbHits} hits={HITS} onPage={goPage} />
        </>
      )}
    </div>
  );
}
