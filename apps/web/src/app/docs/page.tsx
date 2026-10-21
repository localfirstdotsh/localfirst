import type { Metadata } from 'next';
import Link from 'next/link';
import { DOCS_GUIDES } from '../../lib/docs';
import { toolkitPreviewEnabled } from '../../lib/toolkit';

export const metadata: Metadata = {
  title: 'Documentation',
  description: 'Connect your agent, write project specifications, test locally, and create or configure agent environments.',
};

export default function DocsPage() {
  const preview = toolkitPreviewEnabled();
  return (
    <div className="stack gap-32">
      <header className="stack gap-16">
        <h1>Documentation</h1>
        <p className="muted">Connect your tools, work with a shared project, and build locally. Start with the guide for the task in front of you.</p>
      </header>
      <ul className="row-list">
        {DOCS_GUIDES.map(({ href, title, description }) => (
          <li key={href}>
            <div className="row-main stack gap-8">
              <Link className="row-title" href={href}>{title}</Link>
              <p className="muted">{description}</p>
            </div>
          </li>
        ))}
      </ul>
      <section className="panel stack gap-8" aria-labelledby="toolkit">
        <div className="spread"><h2 id="toolkit">Agent toolkit</h2><span className="badge">Design preview</span></div>
        <p className="muted">The toolkit teaches an agent how to discover, publish, and test Localfirst projects. Its install command is proposed; the skill is not yet installable from a release.</p>
        {preview ? (
          <p><Link href="/docs/toolkit">Explore the agent toolkit preview</Link></p>
        ) : (
          <p className="small muted">The preview is disabled on this deployment. The connection and testing guides above describe the available workflows.</p>
        )}
      </section>
    </div>
  );
}
