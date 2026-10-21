'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOCS_GUIDES } from '../lib/docs';

export function DocsPagination() {
  const pathname = usePathname();
  const index = DOCS_GUIDES.findIndex((guide) => guide.href === pathname);
  if (index < 0) return null;
  const previous = DOCS_GUIDES[index - 1];
  const next = DOCS_GUIDES[index + 1];
  return <nav className="docs-pagination" aria-label="Continue reading">
    <Link href={previous?.href ?? '/docs'}><span className="small muted">← Previous</span><strong>{previous?.title ?? 'Overview'}</strong></Link>
    {next && <Link href={next.href}><span className="small muted">Next →</span><strong>{next.title}</strong></Link>}
  </nav>;
}
