import type { ReactNode } from 'react';
import { SearchIcon } from '../ui/SearchIcon';

/** Borderless feedback. The caller owns the copy and navigation for the current query. */
export function EmptyState({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <div className="empty-state" role="status">
      <SearchIcon className="empty-state-icon" />
      <div className="stack gap-8">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
