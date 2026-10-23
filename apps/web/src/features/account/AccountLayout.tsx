import type { ReactNode } from 'react';
import { readAccountSession } from '../../lib/account-session';
import { AccountSidebar } from './AccountSidebar';

/** The one frame for every account page: navigation beside a content column of fixed measure. */
export async function AccountLayout({ children }: { children: ReactNode }) {
  const session = await readAccountSession();
  return (
    <div className="container account-layout">
      <AccountSidebar authBase={session?.authBase ?? '/api/auth'} />
      <div className="account-content">{children}</div>
    </div>
  );
}
