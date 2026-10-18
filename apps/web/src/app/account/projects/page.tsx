import type { Metadata } from 'next';
import { BrowserData } from '../../../components/composites/BrowserData';
import { ownedProjectsSchema } from '../../../lib/browser-schemas';
import { OwnedProjects } from '../../../features/account/OwnedProjects';
export const metadata: Metadata = { title: 'My projects' };
export default function Page() {
  return <BrowserData path="/projects" returnTo="/account/projects" schema={ownedProjectsSchema}>{(data) => <OwnedProjects items={data.items} />}</BrowserData>;
}
