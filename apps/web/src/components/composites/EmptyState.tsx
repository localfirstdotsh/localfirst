import type { ReactNode } from 'react';
import { SearchIcon } from '../ui/SearchIcon';

/** Borderless feedback. The caller owns the copy and navigation for the current query. */
export function EmptyState({ title, description, action, icon = <SearchIcon /> }: {
  title: string;
  description: string;
  action?: ReactNode;
  /** Pass null for feedback that needs no icon. */
  icon?: ReactNode;
}) {
  return (
    <div className="empty-state" role="status">
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <div className="stack gap-8">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
