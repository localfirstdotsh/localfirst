'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon } from '../ui/Icon';
import { SignOutButton } from '../composites/SignOutButton';
import type { AccountSession } from '../../lib/account-session';

/** The signed-in person's Account page and Sign out behind one icon button. In the narrow header menu the list is shown inline. */
export function AccountMenu({ account, onNavigate }: { account: AccountSession; onNavigate: () => void }) {
  const id = useId();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);

  return (
    <div className="account-menu" ref={root}>
      <button ref={trigger} type="button" className="account-menu-trigger" data-active={pathname.startsWith('/account') || undefined} aria-label={account.handle ? `Account menu (signed in as ${account.handle})` : 'Account menu'} aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)}>
        <Icon name="account" />
      </button>
      <div id={`${id}-list`} className="account-menu-list" hidden={!open}>
        <p className="account-menu-label">Account</p>
        <Link href="/account/projects" aria-current={pathname.startsWith('/account') ? 'page' : undefined} onClick={() => { setOpen(false); onNavigate(); }}><Icon name="account" />Account</Link>
        <div className="account-menu-divider" role="separator" />
        <SignOutButton authBase={account.authBase} className="account-menu-item"><Icon name="signout" />Sign out</SignOutButton>
      </div>
    </div>
  );
}
