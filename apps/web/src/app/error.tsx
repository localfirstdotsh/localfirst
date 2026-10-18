'use client';

import { PageContainer } from '../components/layout/PageContainer';

import { Button } from '../components/ui/Button';

import { StatePanel } from '../components/composites/StatePanel';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <PageContainer gap={16} top="hero" width="reading">
      <StatePanel title="Something went wrong" tone="warning" level="h1">
        This page could not be shown. Nothing was changed.
      </StatePanel>
      <div>
        <Button type="button" onClick={reset}>
          Try again
        </Button>
      </div>
    </PageContainer>
  );
}
