import type { Metadata } from 'next';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';
import { SiteHeader } from '../components/layout/SiteHeader';
import { siteUrl } from '../lib/site';
import './globals.css';

const inter = localFont({ src: '../design-system/assets/inter-variable.woff2', variable: '--font-inter', display: 'swap', weight: '100 900' });

// The header and setup section read deployment configuration (API origin, released CLI)
// at request time, so no page may bake build-time values into prerendered HTML.
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { default: 'Localfirst.sh — Discover what you can do with AI', template: '%s · Localfirst.sh' },
  description: 'Find, try, and share AI projects for everyday life, small businesses, and your community.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={inter.variable}>
      <body>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <SiteHeader />
        <main id="main">{children}</main>
        <footer className="site-footer">
          <div className="container footer-content">
            <p>© {new Date().getFullYear()} Localfirst.sh</p>
            <nav aria-label="Footer">
              <a href="/docs">Docs</a>
              <a href="https://github.com/localfirstdotsh/localfirst">GitHub</a>
              <a href="/privacy">Privacy</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
