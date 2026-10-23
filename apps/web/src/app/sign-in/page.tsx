import type { Metadata } from 'next';
import { PageContainer } from '../../components/layout/PageContainer';
import { PageHeader } from '../../components/composites/PageHeader';
import { StatePanel } from '../../components/composites/StatePanel';
import { BrowserData } from '../../components/composites/BrowserData';
import { browserConfigSchema } from '../../lib/browser-schemas';
import { safeReturnPath } from '../../lib/return-path';
import { SignIn } from '../../features/auth/SignIn';
export const metadata: Metadata = { title: 'Sign in', robots: { index: false, follow: false } };
export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const next = safeReturnPath(typeof query.next === 'string' ? query.next : undefined);
  const error = typeof query.error === 'string' ? query.error : undefined;
  return <PageContainer gap={24} top="hero" width="auth">
    <PageHeader title="Sign in to Localfirst">Publish and manage AI projects that run on your own hardware, and approve what your connected agent publishes.</PageHeader>
    {error && <StatePanel title="Sign-in was not completed" tone="warning">{['access_denied', 'user_cancelled'].includes(error) ? 'GitHub sign-in was cancelled. You can try again when you are ready.' : 'GitHub could not complete sign-in. Please try again.'}</StatePanel>}
    <BrowserData level="h2" path="/config" returnTo="/sign-in" schema={browserConfigSchema}>{(data) => data.sign_in_enabled ? <SignIn next={next} authBase={data.auth_base_path} /> : <StatePanel title="GitHub sign-in unavailable" tone="warning">GitHub sign-in is not configured on this deployment.</StatePanel>}</BrowserData>
  </PageContainer>;
}
