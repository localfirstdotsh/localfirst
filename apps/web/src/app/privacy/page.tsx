import type { Metadata } from 'next';
import { PageContainer } from '../../components/layout/PageContainer';
import { PageHeader } from '../../components/composites/PageHeader';
import { DetailsList } from '../../components/composites/DetailsList';
export const metadata: Metadata = { title: 'Privacy' };
export default function PrivacyPage() {
  return <PageContainer gap={24} width="reading"><PageHeader title="Privacy">What the registry counts, and what it does not.</PageHeader>
    <section className="panel stack gap-16" aria-labelledby="usage-counts"><h2 id="usage-counts">Usage counts</h2><p>The registry counts how often a published project is exported or read by an agent, and how many times an application has been authorized to connect. These counts are shown on project pages and the home page.</p>
      <DetailsList rows={[
        ['What is counted', 'A successful export of a published project, a successful read of a published project by an agent over MCP, and each time a new application connection is authorized.'],
        ['What is stored', 'A number per project, version, UTC day, and kind of request. Nothing identifies who made the requests: no account, address, device, browser, token, or search text is stored in a count.'],
        ['What is not counted', 'Requests that fail or are refused by a rate limit, requests for hidden or removed projects, and a project manager reading their own project.'],
        ['What a count means', 'Requests served. It is not a number of people, installs, builds, or runs, and it is approximate: a server crash can lose a few seconds of counts.'],
        ['How long it is kept', "A project's counts are deleted with the project. The total of authorized connections is a single site-wide number; it does not go down when a connection is revoked or an account is deleted."],
      ]} /><p className="muted">Counting needs no account for public reads, and is not tied to signing in or to consent.</p>
    </section>
  </PageContainer>;
}
