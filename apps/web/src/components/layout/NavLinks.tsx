'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

const LINKS = [
  { href: '/projects', label: 'Projects' },
  { href: '/models', label: 'Models' },
  { href: '/hardware', label: 'Hardware' },
  { href: '/builds', label: 'Builds' },
  { href: '/docs', label: 'Docs' },
] as const;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function NavLinks() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const nav = useRef<HTMLElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const pointer = () => { root.dataset.inputModality = 'pointer'; };
    const keyboard = (event: KeyboardEvent) => {
      // Modifiers alone do not indicate an intention to navigate. Chromium's
      // :focus-visible heuristic treats Shift as keyboard input after a click.
      if (!MODIFIERS.has(event.key)) root.dataset.inputModality = 'keyboard';
    };
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('keydown', keyboard, true);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('keydown', keyboard, true);
      delete root.dataset.inputModality;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !nav.current?.contains(event.target) && !button.current?.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); button.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  return (
    <>
      <nav ref={nav} id="primary-navigation" className="nav" aria-label="Primary" data-open={open}>
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`) || (link.label === 'Docs' && pathname.startsWith('/docs/'));
          return <Link key={link.href} href={link.href} aria-current={active ? 'page' : undefined} onClick={() => setOpen(false)}>{link.label}</Link>;
        })}
      </nav>
      <button ref={button} type="button" className="button button-small mobile-menu-button" aria-controls="primary-navigation" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? 'Close' : 'Menu'}
      </button>
    </>
  );
}
