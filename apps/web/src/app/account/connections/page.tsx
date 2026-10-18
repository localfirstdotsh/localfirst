import type { Metadata } from 'next';
import { BrowserData } from '../../../components/composites/BrowserData';
import { connectionsSchema } from '../../../lib/browser-schemas';
import { Connections } from '../../../features/account/Connections';
export const metadata: Metadata = { title: 'Connections' };
export default function Page() {
  return <BrowserData path="/connections" returnTo="/account/connections" schema={connectionsSchema}>{(data) => <Connections data={data} />}</BrowserData>;
}
