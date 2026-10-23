import type { ReactNode } from 'react';

/** A section title with optional supporting text and one trailing action. */
export function SectionHeader({ id, title, action, children, level = 'h2' }: { id?: string; title: string; action?: ReactNode; children?: ReactNode; level?: 'h2' | 'h3' }) {
  const Heading = level;
  return (
    <div className="section-header">
      <div className="stack gap-4">
        <Heading id={id} className="section-title">{title}</Heading>
        {children && <p className="small muted">{children}</p>}
      </div>
      {action}
    </div>
  );
}
