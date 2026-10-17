import type { ReactNode } from 'react';

export function PageHeader({ title, children }: { title: string; children: ReactNode }) {
  return <div className="stack gap-8 page-header"><h1>{title}</h1><p className="muted">{children}</p></div>;
}
