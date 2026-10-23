import type { ReactNode } from 'react';

/** A deliberate step before something that cannot be undone: what will happen, then the actions. */
export function ConfirmationSection({ id, title, tone = 'neutral', level = 'h2', children, actions }: {
  id?: string;
  title: string;
  tone?: 'neutral' | 'danger';
  level?: 'h2' | 'h3';
  children: ReactNode;
  actions?: ReactNode;
}) {
  const Heading = level;
  return (
    <section id={id} className="confirmation" data-tone={tone} aria-labelledby={id ? `${id}-title` : undefined}>
      <Heading id={id ? `${id}-title` : undefined} className="section-title">{title}</Heading>
      <div className="stack gap-12">{children}</div>
      {actions && <div className="browser-actions">{actions}</div>}
    </section>
  );
}
