'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { DOCS_GUIDES } from '../lib/docs';

export function DocsNav({ toolkitPreview }: { toolkitPreview: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const links = [
    { href: '/docs', title: 'Overview' },
    ...DOCS_GUIDES,
    ...(toolkitPreview ? [{ href: '/docs/toolkit', title: 'Agent toolkit · Preview' }] : []),
  ];
  return (
    <>
      <button type="button" className="docs-guide-toggle" aria-expanded={open} aria-controls="docs-navigation" onClick={() => setOpen(!open)}>
        <span><span className="small muted">Browse guides</span><strong>{links.find((link) => link.href === pathname)?.title ?? 'Documentation'}</strong></span>
        <span aria-hidden="true">{open ? '−' : '+'}</span>
      </button>
      <nav id="docs-navigation" className="docs-nav" aria-label="Documentation" data-open={open}>
        {links.map(({ href, title }) => (
          <Link key={href} href={href} aria-current={pathname === href ? 'page' : undefined} onClick={() => setOpen(false)}>{title}</Link>
        ))}
      </nav>
    </>
  );
}
