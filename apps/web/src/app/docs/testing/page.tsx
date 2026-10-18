import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsSection } from '../../../components/DocsSection';
import { publicApiUrl } from '../../../lib/api';

export const metadata: Metadata = { title: 'Testing guide', description: 'Plan and approve local model tests, inspect outcomes, and review sanitized reports before sharing.' };

export default function TestingDocsPage() {
  return (
    <div className="stack gap-32">
      <header className="stack gap-16">
        <h1>Testing guide</h1>
        <p className="muted">Tests run on your machine against an installed local model. The registry serves specifications and evidence; your browser never contacts your local runtime.</p>
      </header>
      <DocsSection id="prerequisites" title="Check what can run">
        <p>Inspect the exact project version, test definition, required capabilities, and <code>runner_available</code>. A declared harness alone does not establish runner support. Documentation-only projects remain useful without an executable test.</p>
        <p>The runner supports bounded declarative text tests and fixed workflows with Ollama or LM Studio. Runtime, engine, model, and structured-output support must pass preflight. Camera, audio, actuation, arbitrary tools, and dynamic graphs are outside this workflow.</p>
        <div className="notice"><h2>Source runner required</h2><p>The <code>localfirstdotsh</code> package is not yet published to npm. From a checkout of the repository, install dependencies with <code>pnpm install --frozen-lockfile</code>, then build:</p></div>
        <pre tabIndex={0}><code>{'pnpm build:contracts\npnpm --filter localfirstdotsh build\nnode packages/runner/dist/cli/bin.js help'}</code></pre>
        <p className="small muted">Commands below run from that repository root. Install your runtime and a suitable model separately; model downloads are not part of planning or execution.</p>
      </DocsSection>
      <DocsSection id="plan" title="Discover and plan a component test">
        <pre tabIndex={0}><code>{`node packages/runner/dist/cli/bin.js runtime discover --runtime ollama --endpoint http://127.0.0.1:11434
node packages/runner/dist/cli/bin.js test plan <project-id> --version <version-id> --test <test-key> --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model> --registry ${publicApiUrl()}`}</code></pre>
        <p>Replace angle-bracket placeholders with IDs from the selected immutable project version and your installed model. For LM Studio, use <code>--runtime lmstudio</code> and its configured loopback endpoint. Approve runtime discovery when prompted.</p>
        <p>Planning reads the bundle, checks compatibility, and saves an exact local plan without inference. Review the selected model, settings, fixtures, file identities, network effects, and request/token/time limits.</p>
      </DocsSection>
      <DocsSection id="run" title="Approve execution and inspect the outcome">
        <pre tabIndex={0}><code>{'node packages/runner/dist/cli/bin.js test run <saved-plan-path>\nnode packages/runner/dist/cli/bin.js report show <saved-report-path>'}</code></pre>
        <p>Use the paths printed by the runner. A person approves the exact execution plan locally. Changed content or settings require a new plan and approval. A cancelled, failed, or partial run remains visible with its actual outcome.</p>
        <p>For multi-agent environments, use <code>environment plan</code> and <code>environment run</code> instead. The <Link href="/docs/environments/create#try-bakery">bakery walkthrough</Link> shows the full sequence and expected fixture outcomes.</p>
        <p><code>--offline</code> allows a saved plan to run without asking the registry about withdrawal or changes. It does not prove that inference was offline. Read the report&apos;s actual locality and network observations.</p>
      </DocsSection>
      <DocsSection id="reports" title="Read workflow reports and share deliberately">
        <pre tabIndex={0}><code>{'node packages/runner/dist/cli/bin.js report trace <saved-report-path> --workspace <prepared-workspace> --out <new-trail.html>\nnode packages/runner/dist/cli/bin.js report export <saved-report-path> --review\nnode packages/runner/dist/cli/bin.js report submit <export-file> --registry ' + publicApiUrl()}</code></pre>
        <p>The local trace shows role prompts, inputs, outputs, steps, and assertion mismatches within its privacy rules. Choose a new output filename. Private-content inclusion in a trace is a separate explicit choice.</p>
        <p>Export and submission are separate from execution. Inspect the sanitized file before uploading. Runs with private input or business-data overrides cannot be exported as public fixture evidence. Submission requires an authorized registry connection and remains private and pending until operator review.</p>
        <p>Component, workflow, and live integration coverage are different. A passing fictional fixture does not prove an inbox, calendar, payment, or business-system integration. See <Link href="/docs/environments/setup#integrations">integration readiness</Link> before using a workflow operationally.</p>
      </DocsSection>
      <DocsSection id="troubleshooting" title="When a test is blocked">
        <ul className="stack gap-8">
          <li><strong>Runtime unreachable:</strong> start the local server and confirm its loopback endpoint.</li>
          <li><strong>Model or profile unsupported:</strong> choose an installed compatible model and supported engine. Unknown capability is not a pass.</li>
          <li><strong>Digest or workspace changed:</strong> prepare the intended bundle in a new directory and plan again.</li>
          <li><strong>Handoff or upload unavailable:</strong> check deployment support. Retain the local report; local execution does not require a hosted upload.</li>
          <li><strong>Assertion mismatch:</strong> inspect expected and actual values and the exact prompts/model. Report the failure without replacing it with an assumed success.</li>
        </ul>
      </DocsSection>
    </div>
  );
}
