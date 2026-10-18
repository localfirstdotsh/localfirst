import type { Metadata } from 'next';
import Link from 'next/link';
import { bakeryBundle, validateProjectBundle } from '@localfirst/contracts';
import { DocsCopyBlock } from '../../../../components/DocsCopyBlock';
import { DocsSection } from '../../../../components/DocsSection';
import { publicApiUrl } from '../../../../lib/api';

export const metadata: Metadata = { title: 'Create an environment', description: 'Author a fixed agent workflow using the complete bakery starter, versioned files, and explicit fixtures.' };

export default function CreateEnvironmentDocsPage() {
  const sample = bakeryBundle();
  const validated = validateProjectBundle({ project_md: sample.project_md, files: sample.files });
  const files = [{ path: 'PROJECT.md', content: sample.project_md }, ...sample.files];
  const brief = `Help me author a Localfirst environment for [business outcome].
Read ${publicApiUrl()}/schemas/project/v0.3.json and /schemas/environment/v0.1.json.
Use localfirst/coordinator/v0.1 and localfirst/runner/v0.2 with the declarative profile.
Start from the bakery starter in /docs/environments/create; inspect its complete files.
Define exact role prompts, input/output schemas, fixed routing, trusted operations,
data access, local model requirements, resource limits, and failure behavior.
Include PROJECT.md, ENVIRONMENT.yaml, referenced prompts/data, and workflow fixtures.
Use fictional public data. Ask about unknown business rules and integrations.
Declare missing adapters as development work; never invent accounts, credentials,
successful tests, or live integrations. Preserve attribution and license references.
Validate the complete bundle and show errors, warnings, file identities, and effects.
Wait for my separate approval before setup, execution, external writes, upload,
or publication. Do not answer an approval prompt for me.`;

  return (
    <div className="stack gap-32">
      <header className="stack gap-16">
        <h1>Create an environment</h1>
        <p className="muted">An environment packages role prompts, data, a fixed workflow, and tests beside its project guide. Author files yourself or use your existing AI client.</p>
      </header>
      <DocsSection id="outcome" title="1. Define the outcome and execution profile">
        <p>Describe the input, expected request draft, owner decisions, and unsupported work. For the bakery starter, a customer message becomes a structured order, a capacity decision, and a draft quote requiring owner review.</p>
        <p>The starter uses project v0.3, environment v0.1, coordinator v0.1, runner v0.2, and the declarative profile. Three roles share one installed local model with chat and JSON output, 4,096 context tokens, temperature 0, and at most 512 output tokens per role. No tested model configuration is claimed by the starter.</p>
        <p>Roles execute in a fixed sequence; trusted operations own capacity, pricing, and the final decision. The declarative profile runs no project code and allows loopback runtime access. The separate <code>langgraph-docker/v0.1</code> profile requires its pinned creator module, dependencies, a local Linux Docker engine, and separate setup approval. Other frameworks and dynamic graphs remain unsupported.</p>
      </DocsSection>
      <DocsSection id="bakery" title="2. Inspect the complete bakery starter">
        <p><strong>Bakery Order Coordinator v0.1.0.</strong> All menu, pricing, capacity, and customer messages are fictional. The specification is MIT; the public fixture inputs are CC0. Preparing the sample writes the complete bundle into a new local workspace.</p>
        <dl className="definition-list">
          <div><dt>Bundle identity</dt><dd className="mono">{validated.content_digest}</dd></div>
          <div><dt>Environment identity</dt><dd className="mono">{sample.test.environment_digest}</dd></div>
          <div><dt>Files</dt><dd>PROJECT.md describes the project; ENVIRONMENT.yaml binds prompts, data and steps; PROMPTS contains exact role instructions; DATA contains business facts; TESTS contains inputs and assertions.</dd></div>
        </dl>
        <p>Expand a file to read or copy its actual packaged contents. This is an executable sample to adapt, with no placeholder credentials or promised integrations.</p>
        <div className="stack gap-8">
          {files.map(({ path, content }) => (
            <details key={path} className="panel docs-file">
              <summary><code>{path}</code></summary>
              <pre tabIndex={0}><code>{content}</code></pre>
            </details>
          ))}
        </div>
        <p className="small muted">The files and digests above come from the same shared-contract sample used by the runner. A changed starter has a new content identity; use a fresh plan for that content.</p>
      </DocsSection>
      <DocsSection id="roles" title="3. Describe roles, data, and trusted operations">
        <ol className="stack gap-8">
          <li><strong>Intake</strong> extracts the current order from the message and menu. Customer text is data, and missing dates or quantities remain unknown.</li>
          <li><strong>Capacity</strong> checks the structured order against declared daily capacity.</li>
          <li><strong>Production</strong> summarizes the order and authoritative capacity result.</li>
          <li><strong>Price and decision</strong> compute the amount and owner-review status deterministically.</li>
          <li><strong>Quote</strong> copies the computed amount and status into a draft for the owner.</li>
        </ol>
        <p>When adapting the bundle, update exact prompts, schemas, references, resource ceilings, and failure behavior together. Prompts describe model roles; computed operations have no invented model prompt. Keep real customer data and credentials outside the public bundle.</p>
        <p>Use declared data keys for private configuration; see <Link href="/docs/environments/setup#configure">private overrides</Link>. For reusable changes, author a distinct bundle/version, recompute its referenced digests, and validate it before planning. Editing a prepared workspace invalidates its recorded content identity.</p>
      </DocsSection>
      <DocsSection id="try-bakery" title="4. Prepare, test, and inspect the example">
        <p>Use the <Link href="/docs/testing#prerequisites">source runner build instructions</Link> first. From the repository root, choose a new workspace and an already installed compatible model:</p>
        <pre tabIndex={0}><code>{'node packages/runner/dist/cli/bin.js environment samples\nnode packages/runner/dist/cli/bin.js environment prepare --sample bakery --out ./bakery\nnode packages/runner/dist/cli/bin.js environment plan ./bakery --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model>\nnode packages/runner/dist/cli/bin.js environment run <saved-plan-path> --offline\nnode packages/runner/dist/cli/bin.js report trace <saved-report-path> --workspace ./bakery --out ./bakery-trail.html'}</code></pre>
        <p>Each stage presents its actual effects and requests local approval where needed. Preparation refuses to overwrite an existing workspace. Planning performs preflight without inference; running uses the saved plan path printed by the runner. The sample has no registry publication, so <code>--offline</code> skips the registry freshness check without establishing offline verification.</p>
        <p>The eight fixtures test complete and corrected orders, missing information, capacity conflicts, unknown decoration, unlisted dates, and customer attempts to override instructions. Expected values below come from the fixture; actual model outputs may fail them.</p>
        <div className="docs-table-scroll" tabIndex={0} role="region" aria-label="Bakery fixture expectations">
          <table>
            <caption>Bakery workflow fixture expectations</caption>
            <thead><tr><th scope="col">Case</th><th scope="col">Decision</th><th scope="col">Total (USD cents)</th></tr></thead>
            <tbody>{sample.test.cases.map((item) => (
              <tr key={item.key}>
                <th scope="row">{item.key}</th>
                <td>{String(item.assertions.find((a) => a.path === '/decision/status')?.equals)}</td>
                <td>{String(item.assertions.find((a) => a.path === '/price/total_minor')?.equals)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
        <p>The complete order is 60 cupcakes, half chocolate and half vanilla with blue icing, for November 6, 2026 at 10:00. Its expected draft total is USD 165.00 with <code>needs_owner_review</code>. The 90-cupcake fixture expects USD 247.50 and <code>capacity_unavailable</code>. These are expected outcomes, not an observed report.</p>
        <p>Open the generated local trail to inspect exact prompts, reconstructed requests where labeled, actual outputs, timing, and assertion mismatches. Keep failed or partial outcomes visible. Create your own fixtures with independently stated assertions, including failure and missing-information cases. See the <Link href="/docs/testing#reports">report guide</Link> before sharing.</p>
        <p>Other bundled examples include florist, print-shop, bike-repair, pet-grooming, bakery-holiday, and stock-replenishment. Use their exact keys with <code>environment prepare --sample</code>; their tests and integration limits are distinct.</p>
      </DocsSection>
      <DocsSection id="publish" title="5. Validate and publish the exact files">
        <p>Ask your connected agent to create a draft containing your <code>PROJECT.md</code> and every declared file, then run <code>draft_validate</code>. Correct blockers at their reported file or field, review warnings, and test supported fixtures locally. Validation never executes the workflow.</p>
        <p>Follow the <Link href="/docs/project-spec#validation">exact-artifact publication review</Link>. Publication approval, execution approval, and report upload are separate decisions. A derived project preserves its parent attribution and has its own tests and evidence.</p>
        <p>Provide your users with the <Link href="/docs/environments/setup">business setup guide</Link>, pinned project/version IDs, and explicit integration requirements.</p>
      </DocsSection>
      <DocsSection id="ai-instructions" title="Author with your AI">
        <p>Replace the business-outcome placeholder in your chosen client. Copying this brief does not connect that client or authorize any action.</p>
        <DocsCopyBlock text={brief} />
      </DocsSection>
    </div>
  );
}
