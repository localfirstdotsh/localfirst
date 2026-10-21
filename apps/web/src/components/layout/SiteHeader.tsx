import Link from 'next/link';
import { NavLinks } from './NavLinks';
import { Logo } from '../ui/Logo';

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container">
        <Link href="/" className="brand">
          <Logo className="brand-mark" aria-hidden="true" focusable="false" />
          localfirst.sh
        </Link>
        <NavLinks />
      </div>
    </header>
  );
}
