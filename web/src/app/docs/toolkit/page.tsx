import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CommandBlock } from '../../../components/composites/CommandBlock';
import { TOOLKIT_BOUNDARIES, TOOLKIT_INSTALL_COMMAND, TOOLKIT_TASKS, toolkitPreviewEnabled } from '../../../lib/toolkit';

export const metadata: Metadata = { title: 'Agent toolkit', robots: { index: false, follow: false } };

// Read per request so the preview flag is a deployment setting, not a build-time constant.
export const dynamic = 'force-dynamic';

const STATUS = [
  { name: 'Agent skill', state: 'In the repository', note: 'Not yet installable from a release.' },
  { name: 'Registry MCP server', state: 'Per deployment', note: 'Hosted at the registry /mcp path; see the connection guide.' },
  { name: 'localfirstdotsh CLI', state: 'Not published', note: 'Built from the repository until it is released.' },
] as const;

export default function ToolkitPreviewPage() {
  if (!toolkitPreviewEnabled()) notFound();

  return (
    <div className="stack gap-32">
      <div className="notice" role="note">
        <h2>Design preview</h2>
        <p>
          This page shows how the agent toolkit will look once it is released. The command below is proposed and does
          not install anything from a release yet. This page is not linked from the site and is hidden from search.
        </p>
      </div>

      <section className="stack gap-16" aria-labelledby="hero">
        <div className="stack gap-8">
          <h1 id="hero">Teach your agent Localfirst</h1>
          <p className="muted lead">
            One skill that shows an agent how to search the registry, publish a project, and test it locally, with you
            approving every step that matters.
          </p>
        </div>
        <CommandBlock
          command={TOOLKIT_INSTALL_COMMAND}
          clients={[]}
          note="Proposed command. Copying it is not an install. It adds guidance to your agent, grants no access, and runs no model."
        />
      </section>

      <section className="stack gap-16" aria-labelledby="loads">
        <h2 id="loads">What your agent learns</h2>
        <p className="muted">
          The skill loads one guide for the task in front of it, so it does not read everything every time.
        </p>
        <ul className="row-list">
          {TOOLKIT_TASKS.map((item) => (
            <li key={item.reference}>
              <div className="row-main">
                <span className="row-title">{item.task}</span>
                <p className="muted mt-4">{item.summary}</p>
              </div>
              <div className="row-side">
                <span className="badge">{item.surface}</span>
                <code className="small">references/{item.reference}.md</code>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="stack gap-16" aria-labelledby="boundaries">
        <h2 id="boundaries">What it will not do</h2>
        <div className="card-grid">
          {TOOLKIT_BOUNDARIES.map((item) => (
            <div className="panel" key={item.title}>
              <h3 className="section-title">{item.title}</h3>
              <p className="muted mt-6">{item.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="stack gap-16" aria-labelledby="status">
        <h2 id="status">Where each piece stands</h2>
        <dl className="definition-list">
          {STATUS.map((item) => (
            <div key={item.name}>
              <dt>{item.name}</dt>
              <dd>
                <span className="badge">{item.state}</span>
                <span className="muted small ml-8">{item.note}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="small muted">
          Already connected an agent? See the <a href="/docs/connect">connection guide</a>.
        </p>
      </section>
    </div>
  );
}
