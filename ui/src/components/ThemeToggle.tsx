import { useEffect, useState } from 'react';

// Toggles the "kitchen after dark" comal theme via [data-theme] on <html>,
// persisted to localStorage (initialised in main.tsx to avoid a flash).
export function ThemeToggle() {
  const [dark, setDark] = useState(
    () => typeof document !== 'undefined' && document.documentElement.dataset.theme === 'dark',
  );
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('olla-theme', dark ? 'dark' : 'light');
    } catch {
      /* ignore */
    }
  }, [dark]);
  return (
    <button
      className="theme-toggle"
      aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={dark ? 'Light' : 'Dark'}
      onClick={() => setDark((d) => !d)}
    >
      {dark ? '☀' : '🌙'}
    </button>
  );
}
