import type { ReactNode } from 'react';
import { DocsNav } from '../../components/DocsNav';
import { toolkitPreviewEnabled } from '../../lib/toolkit';

export default function DocsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="container docs-layout">
      <aside className="docs-sidebar">
        <p className="small muted">Documentation</p>
        <DocsNav toolkitPreview={toolkitPreviewEnabled()} />
      </aside>
      <div className="docs-content">{children}</div>
    </div>
  );
}
