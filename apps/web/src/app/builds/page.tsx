import type { Metadata } from 'next';
import Link from 'next/link';
import { PendingPage } from '../../components/composites/PendingPage';

export const metadata: Metadata = { title: 'Builds' };

export default function BuildsPage() {
  return (
    <PendingPage title="Builds">
      <p>
        A build combines a project version with the models, runtime, and hardware it was set up on. Public build
        records are not available yet, so nothing is listed here and no results are implied.
      </p>
      <p>
        <Link href="/projects">Browse projects</Link>
      </p>
    </PendingPage>
  );
}
