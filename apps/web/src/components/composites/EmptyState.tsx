import type { ReactNode } from 'react';
import { SearchIcon } from '../ui/SearchIcon';

/** Borderless feedback. The caller owns the copy and navigation for the current query. */
export function EmptyState({ title, description, action, icon = <SearchIcon />, compact = false }: {
  title: string;
  description: string;
  action?: ReactNode;
  /** Pass null for feedback that needs no icon. */
  icon?: ReactNode;
  /** A short, left-aligned block for a section inside a page, instead of a centred full-width state. */
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'empty-state empty-state-compact' : 'empty-state'} role="status">
      {icon && <span className="empty-state-icon" aria-hidden="true">{icon}</span>}
      <div className="stack gap-8">
        <h2>{title}</h2>
        <p className="muted">{description}</p>
      </div>
      {action}
    </div>
  );
}
