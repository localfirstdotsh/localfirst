import type { Metadata } from 'next';
import { BrowserData } from '../../../components/composites/BrowserData';
import { devicesSchema } from '../../../lib/browser-schemas';
import { Devices } from '../../../features/account/Devices';
export const metadata: Metadata = { title: 'Approval devices' };
export default async function DevicesPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const raw = (await searchParams).code;
  const code = typeof raw === 'string' ? raw : '';
  const query = `?code=${encodeURIComponent(code)}`;
  return <BrowserData path={`/devices${query}`} returnTo={`/account/devices${query}`} schema={devicesSchema}>{(data) => <Devices data={data} code={code} />}</BrowserData>;
}
