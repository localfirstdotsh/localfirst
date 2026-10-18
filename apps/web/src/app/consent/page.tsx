import type { Metadata } from 'next';
import { headers } from 'next/headers';
import { PageContainer } from '../../components/layout/PageContainer';
import { PageHeader } from '../../components/composites/PageHeader';
import { BrowserData } from '../../components/composites/BrowserData';
import { consentSchema } from '../../lib/browser-schemas';
import { Consent } from '../../features/auth/Consent';
export const metadata: Metadata = { title: 'Authorize', robots: { index: false, follow: false } };
export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, item);
  // proxy.ts passes the original query verbatim; OAuth's signed query must not be normalized.
  const original = (await headers()).get('x-browser-query') ?? params.toString();
  return <PageContainer gap={24} top="hero" width="reading"><PageHeader title="Authorize an application">Choose whether this application can access your Localfirst records.</PageHeader>
    <BrowserData level="h2" path={`/consent?${original}`} returnTo={`/consent?${original}`} schema={consentSchema}>{(data) => <Consent data={data} query={original} />}</BrowserData>
  </PageContainer>;
}
