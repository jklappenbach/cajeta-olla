export function Pagination({
  page,
  nb,
  hits,
  onPage,
}: {
  page: number;
  nb: number;
  hits: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(nb / hits));
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button
        className="btn ghost small"
        disabled={page <= 0}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="page-info">
        Page {page + 1} of {pages}
      </span>
      <button
        className="btn ghost small"
        disabled={page >= pages - 1}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
