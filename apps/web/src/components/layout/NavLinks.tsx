'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { AccountSession } from '../../lib/account-session';
import { AccountMenu } from './AccountMenu';

const LINKS = [
  { href: '/docs', label: 'Docs' },
] as const;
const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

export function NavLinks({ account }: { account: AccountSession | null }) {
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
      <button ref={button} type="button" className="button mobile-menu-button" aria-label="Menu" aria-controls="primary-navigation" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d={open ? 'M6 6l12 12M6 18L18 6' : 'M4 6h16M4 12h16M4 18h16'} />
        </svg>
      </button>
      <nav ref={nav} id="primary-navigation" className="nav" aria-label="Primary" data-open={open}>
        {LINKS.map((link) => {
          const active = pathname === link.href || pathname.startsWith(`${link.href}/`) || (link.label === 'Docs' && pathname.startsWith('/docs/'));
          return <Link key={link.href} href={link.href} aria-current={active ? 'page' : undefined} onClick={() => setOpen(false)}>{link.label}</Link>;
        })}
        {account
          ? <AccountMenu account={account} onNavigate={() => setOpen(false)} />
          : pathname !== '/sign-in' && <a href="/sign-in" className="button button-small nav-sign-in" onClick={() => setOpen(false)}>Sign in</a>}
      </nav>
    </>
  );
}
