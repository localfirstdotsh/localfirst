'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { DOCS_GUIDES } from '../lib/docs';

export function DocsNav({ toolkitPreview }: { toolkitPreview: boolean }) {
  const pathname = usePathname();
  const links = [
    { href: '/docs', title: 'Overview' },
    ...DOCS_GUIDES,
    ...(toolkitPreview ? [{ href: '/docs/toolkit', title: 'Agent toolkit · Preview' }] : []),
  ];
  return (
    <nav className="docs-nav" aria-label="Documentation">
      {links.map(({ href, title }) => (
        <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined}>{title}</Link>
      ))}
    </nav>
  );
}
