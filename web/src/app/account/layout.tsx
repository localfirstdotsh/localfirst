import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PageContainer } from '../../components/layout/PageContainer';
import { AccountNav } from '../../features/account/AccountNav';
export const metadata: Metadata = { title: 'Account', robots: { index: false, follow: false } };
export default function AccountLayout({ children }: { children: ReactNode }) {
  return <PageContainer gap={24}><AccountNav />{children}</PageContainer>;
}
