import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { CaramelCube } from './Logo';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <nav className="nav">
        <div className="container nav-inner">
          <Link to="/" className="brand">
            <CaramelCube />
            Olla
          </Link>
          <div className="nav-spacer" />
          <Link to="/packages" className="navlink">
            Browse
          </Link>
          <Link to="/search" className="navlink">
            Search
          </Link>
          <a
            className="navlink"
            href="https://github.com/jklappenbach/cajeta-olla"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
        </div>
      </nav>
      <main>{children}</main>
      <footer className="footer">
        <div className="container">
          <CaramelCube />
          <span>
            Olla — the package registry for{' '}
            <a href="https://github.com/jklappenbach/cajeta" target="_blank" rel="noreferrer">
              Cajeta
            </a>
            . Caramel, cream &amp; clay.
          </span>
        </div>
      </footer>
    </>
  );
}
