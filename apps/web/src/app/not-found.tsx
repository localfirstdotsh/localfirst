import { PageContainer } from '../components/layout/PageContainer';
import Link from 'next/link';
import { StatePanel } from '../components/composites/StatePanel';

export default function NotFound() {
  return (
    <PageContainer top="hero" width="reading">
      <StatePanel title="Page not found" level="h1">
        This page does not exist, or it is not available to you. <Link href="/projects">Browse projects</Link>
      </StatePanel>
    </PageContainer>
  );
}
