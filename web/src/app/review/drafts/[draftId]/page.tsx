import type { Metadata } from 'next';
import { PageContainer } from '../../../../components/layout/PageContainer';
import { BrowserData } from '../../../../components/composites/BrowserData';
import { draftReviewSchema } from '../../../../lib/browser-schemas';
import { PublicationReview } from '../../../../features/review/PublicationReview';
export const metadata: Metadata = { title: 'Review publication', robots: { index: false, follow: false } };
export default async function ReviewPage({ params, searchParams }: { params: Promise<{ draftId: string }>; searchParams: Promise<{ review?: string }> }) {
  const id = encodeURIComponent((await params).draftId);
  const query = (await searchParams).review === 'again' ? '?review=again' : '';
  return <PageContainer gap={24}><BrowserData path={`/drafts/${id}/review${query}`} returnTo={`/review/drafts/${id}${query}`} schema={draftReviewSchema}>{(data) => <PublicationReview data={data} />}</BrowserData></PageContainer>;
}
