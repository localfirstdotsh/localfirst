import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AccountLayout } from '../../features/account/AccountLayout';
export const metadata: Metadata = { title: 'Account', robots: { index: false, follow: false } };
export default function Layout({ children }: { children: ReactNode }) {
  return <AccountLayout>{children}</AccountLayout>;
}
