import { useNavigate } from 'react-router-dom';

// Clickable keyword tags → run a search for that keyword. Buttons (not links)
// so they can live inside a card without nesting anchors.
export function KeywordChips({ keywords, max = 8 }: { keywords: string; max?: number }) {
  const nav = useNavigate();
  const list = keywords
    .split(/[\s,]+/)
    .map((k) => k.trim())
    .filter(Boolean)
    .slice(0, max);
  if (list.length === 0) return null;
  return (
    <div className="chips">
      {list.map((k) => (
        <button
          key={k}
          className="chip"
          onClick={(e) => {
            e.stopPropagation();
            nav(`/search?q=${encodeURIComponent(k)}`);
          }}
        >
          {k}
        </button>
      ))}
    </div>
  );
}
