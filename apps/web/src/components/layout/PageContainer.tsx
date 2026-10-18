import type { ReactNode } from 'react';

/** Only the page widths and rhythms already used by the application. */
export function PageContainer({ children, gap, top = 'standard', width = 'full' }: {
  children: ReactNode;
  gap?: 16 | 24 | 32;
  top?: 'detail' | 'standard' | 'hero';
  width?: 'auth' | 'full' | 'error' | 'reading' | 'docs' | 'preview';
}) {
  return <div className={`container page-container page-top-${top} page-width-${width}${gap ? ` stack gap-${gap}` : ''}`}>{children}</div>;
}
