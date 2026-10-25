import type { ReactNode } from 'react';
import { AccountSidebar } from './AccountSidebar';

/** The one frame for every account page: navigation beside a content column of fixed measure. */
export function AccountLayout({ children }: { children: ReactNode }) {
  return (
    <div className="container account-layout">
      <AccountSidebar />
      <div className="account-content">{children}</div>
    </div>
  );
}
