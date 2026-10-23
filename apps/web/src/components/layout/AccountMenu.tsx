'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { Icon, type IconName } from '../ui/Icon';
import { SignOutButton } from '../composites/SignOutButton';
import type { AccountSession } from '../../lib/account-session';

const ITEMS: ReadonlyArray<{ href: string; label: string; icon: IconName }> = [
  { href: '/account/projects', label: 'My projects', icon: 'projects' },
  { href: '/account/connections', label: 'Connections', icon: 'connections' },
  { href: '/account/devices', label: 'Approval devices', icon: 'devices' },
];

/** The signed-in person's pages and Sign out behind one header control. In the narrow header menu the list is shown inline. */
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
      <button ref={trigger} type="button" className="account-menu-trigger" data-active={pathname.startsWith('/account') || undefined} aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen(!open)}>
        <Icon name="account" />Account{account.handle && <span className="visually-hidden"> (signed in as {account.handle})</span>}<Icon name="chevron" className="disclosure-chevron" />
      </button>
      <div id={`${id}-list`} className="account-menu-list" hidden={!open}>
        <p className="account-menu-label">Account</p>
        {ITEMS.map(({ href, label, icon }) => <Link key={href} href={href} aria-current={pathname.startsWith(href) ? 'page' : undefined} onClick={() => { setOpen(false); onNavigate(); }}><Icon name={icon} />{label}</Link>)}
        <div className="account-menu-divider" role="separator" />
        <SignOutButton authBase={account.authBase} className="account-menu-item"><Icon name="signout" />Sign out</SignOutButton>
      </div>
    </div>
  );
}
