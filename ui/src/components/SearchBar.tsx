import { useState } from 'react';

export function SearchBar({
  initial = '',
  onSubmit,
  autoFocus = false,
}: {
  initial?: string;
  onSubmit: (q: string) => void;
  autoFocus?: boolean;
}) {
  const [q, setQ] = useState(initial);
  return (
    <form
      className="searchbar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(q.trim());
      }}
    >
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus={autoFocus}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search packages — try “http”, “json”, “stream”…"
        aria-label="Search packages"
      />
      <button className="btn" type="submit">
        Search
      </button>
    </form>
  );
}
