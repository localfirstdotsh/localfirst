import type { ReactNode } from 'react';

/** Distinct empty, unavailable, and error states (FRONTEND_PRD section 15). */
export function StatePanel({
  title,
  children,
  tone = 'neutral',
  requestId,
  level = 'h2',
}: {
  title: string;
  children?: ReactNode;
  tone?: 'neutral' | 'warning';
  requestId?: string | null;
  /** Heading level: h1 when the panel is the whole page, h3 when nested under a section heading. */
  level?: 'h1' | 'h2' | 'h3';
}) {
  const Heading = level;
  return (
    <div className={tone === 'warning' ? 'notice' : 'panel'} role={tone === 'warning' ? 'alert' : 'status'}>
      <Heading className={level === 'h1' ? 'state-panel-title-page' : 'state-panel-title'}>{title}</Heading>
      {children && <div className="mt-6">{children}</div>}
      {requestId && <p className="small muted mono mt-8">Request ID: {requestId}</p>}
    </div>
  );
}
