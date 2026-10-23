'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, type IconName } from '../../components/ui/Icon';
import { SignOutButton } from '../../components/composites/SignOutButton';

const LINKS: ReadonlyArray<{ key: string; label: string; icon: IconName; danger?: true }> = [
  { key: 'projects', label: 'My projects', icon: 'projects' },
  { key: 'connections', label: 'Connections', icon: 'connections' },
  { key: 'devices', label: 'Approval devices', icon: 'devices' },
  { key: 'delete', label: 'Danger zone', icon: 'danger', danger: true },
];

/** One list of account pages: a side column on wide screens, a compact wrapped row on narrow ones. */
export function AccountSidebar({ authBase }: { authBase: string }) {
  const path = usePathname();
  return (
    <nav className="account-nav" aria-label="Account">
      <p className="account-nav-label muted">Account</p>
      <ul>
        {LINKS.map(({ key, label, icon, danger }) => {
          const href = `/account/${key}`;
          return <li key={key} data-danger={danger}><Link href={href} aria-current={path === href || path.startsWith(`${href}/`) ? 'page' : undefined}><Icon name={icon} />{label}</Link></li>;
        })}
        <li className="account-signout"><SignOutButton authBase={authBase} className="account-signout-button"><Icon name="signout" />Sign out</SignOutButton></li>
      </ul>
    </nav>
  );
}
