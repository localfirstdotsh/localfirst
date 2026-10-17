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
    <PageHeader title="Sign in to Localfirst">Manage your projects and approve publications.</PageHeader>
    {error && <StatePanel title="Sign-in was not completed" tone="warning">{['access_denied', 'user_cancelled'].includes(error) ? 'GitHub sign-in was cancelled. You can try again when you are ready.' : 'GitHub could not complete sign-in. Please try again.'}</StatePanel>}
    <BrowserData level="h2" path="/config" returnTo="/sign-in" schema={browserConfigSchema}>{(data) => data.sign_in_enabled ? <SignIn next={next} authBase={data.auth_base_path} /> : <StatePanel title="GitHub sign-in unavailable" tone="warning">GitHub sign-in is not configured on this deployment.</StatePanel>}</BrowserData>
    <p className="small muted security-note">GitHub verifies your identity. Signing in does not grant agents access to your account.</p>
    <details><summary>How your access stays separate</summary><p className="small muted">GitHub sign-in asks only for identity and email. It never requests permission to write to your repositories. Your GitHub token is never a Localfirst API credential. Signing in does not approve any artifact or local test. These pages never run models, read local files, or use runtime credentials.</p></details>
  </PageContainer>;
}
