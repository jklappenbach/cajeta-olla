import { useNavigate } from 'react-router-dom';
import { CaramelCube } from '../components/Logo';
import { SearchBar } from '../components/SearchBar';

export function Home() {
  const nav = useNavigate();
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
          or <a href="/packages">browse every library →</a>
        </p>
      </section>
    </div>
  );
}
