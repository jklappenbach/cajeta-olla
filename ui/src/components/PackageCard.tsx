import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';
import { KeywordChips } from './KeywordChips';

// A catalog/search result card. The name is the navigation target; keyword
// chips (when provided) are separate buttons so we don't nest anchors.
export function PackageCard({
  name,
  version,
  description,
  keywords,
  badges,
}: {
  name: string;
  version?: string | null;
  description: string;
  keywords?: string;
  badges?: ReactNode;
}) {
  return (
    <div className="card">
      <Link to={`/p/${encodeURIComponent(name)}`} className="pkg-name-link">
        <span className="pkg-name">{name}</span>
        {version && <span className="badge">{version}</span>}
        {badges}
      </Link>
      <div className="pkg-desc">{description || 'No description.'}</div>
      {keywords ? <KeywordChips keywords={keywords} /> : null}
    </div>
  );
}
