import type { Metadata } from 'next';
import { BrowserData } from '../../../components/composites/BrowserData';
import { deletionPreviewSchema } from '../../../lib/browser-schemas';
import { Deletion } from '../../../features/account/Deletion';
export const metadata: Metadata = { title: 'Account deletion' };
export default function Page() {
  return <BrowserData path="/deletion-preview" returnTo="/account/delete" schema={deletionPreviewSchema}>{(data) => <Deletion data={data} />}</BrowserData>;
}
