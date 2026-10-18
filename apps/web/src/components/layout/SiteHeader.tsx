import Link from 'next/link';
import { NavLinks } from './NavLinks';

export function SiteHeader() {
  const signIn = '/sign-in';
  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand">
          <span className="brand-mark" aria-hidden="true">›</span>
          localfirst.sh
        </Link>
        <NavLinks />
        <div className="header-actions">
          <a href={signIn} className="button button-small">
            Sign in
          </a>
        </div>
      </div>
    </header>
  );
}
