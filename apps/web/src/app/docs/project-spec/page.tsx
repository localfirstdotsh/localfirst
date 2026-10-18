import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsSection } from '../../../components/DocsSection';
import { publicApiUrl } from '../../../lib/api';

export const metadata: Metadata = { title: 'Project specification', description: 'Author and validate a portable Localfirst PROJECT.md and its versioned bundle.' };

export default function ProjectSpecDocsPage() {
  const api = publicApiUrl();
  return (
    <div className="stack gap-32">
      <header className="stack gap-16">
        <h1>Project specification</h1>
        <p className="muted">A project is a portable <code>PROJECT.md</code>: YAML frontmatter for structured requirements, followed by readable Markdown explaining how to use it. A repository URL is optional for original authored specifications.</p>
      </header>
      <DocsSection id="schema" title="Choose the contract">
        <p>Use <a href={`${api}/schemas/project/v0.2.json`}>project v0.2</a> for projects without agent environments. Use <a href={`${api}/schemas/project/v0.3.json`}>project v0.3</a> for environment bundles; it adds environment declarations and workflow tests. Read the deployment&apos;s live schema before authoring.</p>
        <p>For a complete environment specification and every referenced file, use the <Link href="/docs/environments/create#bakery">bakery starter</Link>. Its executable values are fictional sample data; replace them deliberately when making your own project.</p>
      </DocsSection>
      <DocsSection id="metadata" title="Describe requirements and provenance">
        <dl className="definition-list">
          <div><dt>Identity</dt><dd><code>schema</code> and <code>project</code>: stable key, name, summary, type, categories, version, and license state.</dd></div>
          <div><dt>Source and attribution</dt><dd><code>sources</code> and <code>attribution</code>: source kind, immutable revision or digest when known, authors, and your relationship to the work. Original authored specifications can use a null source URL.</dd></div>
          <div><dt>Requirements</dt><dd><code>models</code>, <code>runtimes</code>, <code>hardware</code>, <code>operating_systems</code>, and <code>dependencies</code>: explicit declaration states, required capabilities, and known constraints.</dd></div>
          <div><dt>Configuration</dt><dd><code>configurations</code>, <code>data_boundary</code>, <code>test_support</code>, and <code>limitations</code>: setup, role bindings, inference/storage/network boundaries, supported tests, and practical limits.</dd></div>
          <div><dt>Versioned files</dt><dd><code>tests</code> references test manifests. Project v0.3 also requires <code>environments</code> with keys, paths, and digests. Referenced prompts, data, and fixtures travel with the bundle.</dd></div>
          <div><dt>Optional detail</dt><dd>Evidence references, licensed media, derivative lineage, and bounded extensions. These do not grant verification or execution permissions.</dd></div>
        </dl>
        <p>Unknown values stay <code>null</code> or use the field&apos;s explicit unknown state. A preferred model is a suggestion; observed model identity and test evidence are separate facts. The schema rejects unknown fields outside <code>extensions</code>.</p>
      </DocsSection>
      <DocsSection id="body" title="Write the human-readable guide">
        <p>Include the required sections: <strong>Purpose</strong>, <strong>Setup</strong>, <strong>Limitations</strong>, and <strong>Sources and attribution</strong>. Add <strong>Architecture and workflow</strong>, <strong>Execution</strong>, and <strong>Test and evaluation</strong> so another person can reproduce the intended process.</p>
        <p>Explain manual steps, unsupported integrations, private configuration, and expected outputs. Use quoted strings for dates in YAML. Anchors, aliases, custom tags, and merge keys are rejected.</p>
      </DocsSection>
      <DocsSection id="validation" title="Validate and publish with your agent">
        <ol className="stack gap-8">
          <li><Link href="/docs/connect">Connect your agent</Link> and ask it to prepare a draft from your specification and declared files.</li>
          <li>Have it call <code>draft_validate</code> for the current revision. Validation checks structure, referenced files, digests, and safety findings; it does not execute the project.</li>
          <li>Fix each blocking error at its reported field or file. Review warnings and unknown requirements before approval.</li>
          <li>Open the review URL from your agent. Inspect the exact revision, file set, digest, permissions, and warnings, then decide whether to approve publication.</li>
          <li>Your agent publishes the approved artifact. A changed draft needs fresh approval; a published version is immutable.</li>
        </ol>
        <p>Publication does not run tests or prove a claim. Follow the <Link href="/docs/testing">testing guide</Link> for local execution and separately reviewed evidence.</p>
      </DocsSection>
    </div>
  );
}
