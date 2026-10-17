'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
const LINKS = [['projects', 'My projects'], ['connections', 'Connections'], ['devices', 'Approval devices'], ['delete', 'Danger zone']] as const;
export function AccountNav() {
  const path = usePathname();
  return <nav className="account-nav" aria-label="Account settings">{LINKS.map(([key, label]) => <Link key={key} href={`/account/${key}`} aria-current={path === `/account/${key}` || path.startsWith(`/account/${key}/`) ? 'page' : undefined}>{label}</Link>)}</nav>;
}
