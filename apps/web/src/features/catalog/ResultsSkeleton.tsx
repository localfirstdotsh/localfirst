/** Layout-preserving placeholder: same row rhythm as a result, so the page does not jump. */
export function ResultsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="results-skeleton discovery-list" role="status" aria-busy="true" aria-label="Loading projects">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="result">
          <span className="result-icon skeleton" />
          <div className="result-body">
            <span className="skeleton skeleton-line" data-length="short" />
            <span className="skeleton skeleton-line" data-length="long" />
            <span className="skeleton skeleton-line" data-length="medium" />
          </div>
        </div>
      ))}
    </div>
  );
}
