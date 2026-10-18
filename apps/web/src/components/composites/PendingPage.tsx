import { PageContainer } from '../layout/PageContainer';
import type { ReactNode } from 'react';

/** Honest placeholder for a phase-gated route; never shows fabricated data (FRONTEND_PRD sections 2, 8.1). */
export function PendingPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <PageContainer gap={16} top="hero" width="reading">
      <h1>{title}</h1>
      <div className="stack gap-8">{children}</div>
    </PageContainer>
  );
}
