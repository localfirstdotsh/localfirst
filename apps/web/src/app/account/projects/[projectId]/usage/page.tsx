import type { Metadata } from 'next';
import { BrowserData } from '../../../../../components/composites/BrowserData';
import { ownedUsageSchema } from '../../../../../lib/browser-schemas';
import { ProjectUsage } from '../../../../../features/account/ProjectUsage';
export const metadata: Metadata = { title: 'Usage' };
export default async function UsagePage({ params, searchParams }: { params: Promise<{ projectId: string }>; searchParams: Promise<{ days?: string }> }) {
  const { projectId } = await params;
  const days = (await searchParams).days === '90' ? 90 : 30;
  const id = encodeURIComponent(projectId);
  return <BrowserData path={`/projects/${id}/usage?days=${days}`} returnTo={`/account/projects/${id}/usage?days=${days}`} schema={ownedUsageSchema}>{(data) => <ProjectUsage data={data} />}</BrowserData>;
}
