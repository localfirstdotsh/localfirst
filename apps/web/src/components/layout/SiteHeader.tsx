import Link from 'next/link';
import { NavLinks } from './NavLinks';
import { Logo } from '../ui/Logo';
import { readAccountSession } from '../../lib/account-session';

export async function SiteHeader() {
  const account = await readAccountSession();
  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand">
          <Logo className="brand-mark" aria-hidden="true" focusable="false" />
          localfirst.sh
        </Link>
        <NavLinks account={account} />
      </div>
    </header>
  );
}
