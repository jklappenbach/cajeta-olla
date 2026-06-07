import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App';

// Apply the saved theme before first paint (avoids a flash of light mode).
try {
  document.documentElement.dataset.theme = localStorage.getItem('olla-theme') || 'light';
} catch {
  document.documentElement.dataset.theme = 'light';
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
