import type { ReactNode } from 'react';

export function DocsSection({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section className="stack gap-16" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {children}
    </section>
  );
}
