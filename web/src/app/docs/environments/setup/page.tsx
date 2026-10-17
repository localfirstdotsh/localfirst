import type { Metadata } from 'next';
import Link from 'next/link';
import { DocsCopyBlock } from '../../../../components/DocsCopyBlock';
import { DocsSection } from '../../../../components/DocsSection';
import { publicApiUrl } from '../../../../lib/api';

export const metadata: Metadata = { title: 'Set up for your business', description: 'Prepare a versioned workflow, configure private business data, review a local plan, and assess integrations.' };

export default function SetupEnvironmentDocsPage() {
  const api = publicApiUrl();
  return (
    <div className="stack gap-32">
      <header className="stack gap-16">
        <h1>Set up for your business</h1>
        <p className="muted">Start from an exact project version, test its public example, then configure your private data locally. The bakery example prepares drafts for owner review; it does not receive messages or book orders.</p>
      </header>
      <DocsSection id="prepare" title="1. Inspect requirements and prepare files">
        <p>From the project&apos;s Versions page, select an immutable version and keep its project ID, version ID, environment key, and content digest. Read its runtime/model requirements, license, file list, test evidence, and integration limitations.</p>
        <p>Use the <Link href="/docs/testing#prerequisites">source runner</Link> with Node.js 22 or newer, an installed Ollama or LM Studio server, and a compatible local model. The recorded runtime checks cover macOS arm64; other operating systems need their own verification. A declarative sample needs no inbox, payment, or store account.</p>
        <pre tabIndex={0}><code>{`node runner/dist/cli/bin.js environment prepare <project-id> --version <version-id> --environment <environment-key> --registry ${api} --out ./my-business`}</code></pre>
        <p>Replace placeholders with the selected version&apos;s actual IDs. Preparation copies the declared bundle into a new directory and does not install a model or dependencies. It preserves existing work by refusing an occupied destination. If environment retrieval is disabled on the deployment, use the author&apos;s exact bundle with <code>environment prepare --bundle &lt;bundle-dir&gt; --out &lt;new-dir&gt;</code>, or try the <Link href="/docs/environments/create#try-bakery">bundled sample</Link>.</p>
        <p className="small muted">Setup effort depends on your installed runtime and model, hardware, workflow profile, and any missing adapter. Public sample preparation is a terminal workflow; live integration work requires a developer and separate provider configuration. No measured setup-time estimate is available.</p>
      </DocsSection>
      <DocsSection id="configure" title="2. Configure private business information">
        <p>Run the public fixture first. For your own request, store a private JSON input locally. The bakery input contains a <code>message</code>; intake extracts items and quantities, requested date/time, and decoration. Missing or unsupported details require owner clarification.</p>
        <pre tabIndex={0}><code>{'{\n  "message": "60 cupcakes: 30 chocolate and 30 vanilla, blue icing. Pickup 2026-11-06 at 10:00."\n}'}</code></pre>
        <p>Use <code>--data</code> with a separate JSON object keyed by declared dataset names such as <code>menu</code>, <code>capacity</code>, and <code>prices</code>. Each supplied value replaces that dataset completely; it is not a partial merge. Copy the dataset&apos;s full shape from the <Link href="/docs/environments/create#bakery">starter files</Link> and edit local facts.</p>
        <pre tabIndex={0}><code>{'{\n  "capacity": {\n    "slots": [\n      { "date": "2026-11-06", "available_units": 100 }\n    ]\n  }\n}'}</code></pre>
        <p>Keep private files outside the published bundle and repository history. Overrides cannot change prompts, executable code, paths, or permissions. These runs are local experiments; their structural checks do not measure public-fixture accuracy, and export as public evidence is disabled.</p>
        <p>The declarative bakery workflow has no external account connector and needs no business-service credentials. An added adapter needs its own documented secret storage and scopes; never put tokens into public data, prompts, or project drafts.</p>
      </DocsSection>
      <DocsSection id="review" title="3. Review, test, and inspect results">
        <pre tabIndex={0}><code>{'node runner/dist/cli/bin.js environment plan ./my-business --runtime ollama --endpoint http://127.0.0.1:11434 --model <installed-model> --input <private-input.json> --data <private-business-data.json>\nnode runner/dist/cli/bin.js environment run <saved-plan-path>\nnode runner/dist/cli/bin.js report trace <saved-report-path> --workspace ./my-business --out <new-trail.html>'}</code></pre>
        <p>To test the public fixtures, omit <code>--input</code> and <code>--data</code>. Use LM Studio&apos;s runtime name and loopback endpoint when applicable. Review every role/model binding, prompt/data identity, output destination, resource ceiling, and network or file effect before approving the saved plan locally.</p>
        <p>A private request is observed for structure and execution, not graded against the public fixture&apos;s expected answer. Inspect the actual order, computed capacity and price, owner-review status, and generated draft. Confirm business correctness yourself; a successful process does not accept an order.</p>
        <p>The local trail omits private content unless you explicitly choose to include it. Treat any full local trace as private. Nothing is uploaded automatically; <Link href="/docs/testing#reports">report sharing</Link> has its own review.</p>
      </DocsSection>
      <DocsSection id="integrations" title="4. Assess each integration before operating">
        <dl className="definition-list">
          <div><dt>Manual input</dt><dd>The source runner accepts a local JSON request. You supply the input, run it deliberately, and review each output. Public fixtures exercise this local workflow.</dd></div>
          <div><dt>File import</dt><dd>Declared JSON datasets can be overridden locally. Mapping arbitrary CSV exports or provider records into those shapes requires a separate conversion step.</dd></div>
          <div><dt>Your AI client</dt><dd><Link href="/docs/connect">Localfirst MCP</Link> retrieves specifications and versioned files and can offer a gated local-plan handoff. It does not ingest customer messages or grant access to your business systems.</dd></div>
          <div><dt>Inbox, POS, calendar</dt><dd>The bakery sample requires development for these adapters. Specify provider accounts, input triggers, mapping, authentication scopes, read/write effects, duplicate/retry handling, corrections, and disconnection before connecting one.</dd></div>
          <div><dt>Stock replenishment</dt><dd>The stock-replenishment sample reviews complete fictional snapshots and drafts an owner proposal. Continuous monitoring, live stock/vendor checks, notifications, and purchase orders require development.</dd></div>
        </dl>
        <p>For your selected version, ask the author what is implemented and tested, requires configuration, requires development, or remains unknown. Tie any tested claim to an actual scoped result. A successful synthetic fixture cannot establish a live connector.</p>
        <p>Connection consent, dependency setup, local execution, external business writes, report upload, and publication are separate approvals. Generated advice does not authorize any of them.</p>
      </DocsSection>
      <DocsSection id="recover" title="5. Operate and recover locally">
        <p>The supported mode is a deliberate terminal run with local reports. There is no unattended inbox watcher or automatic order placement. Inspect errors and partial outputs in the report before deciding to rerun.</p>
        <ul className="stack gap-8">
          <li>If runtime preflight fails, check the installed model, endpoint, and supported output profile using the <Link href="/docs/testing#troubleshooting">testing troubleshooting guide</Link>.</li>
          <li>If private configuration is wrong, preserve the prior file, correct its replacement, and make a fresh plan. Changed data invalidates approval.</li>
          <li>If you edited prepared project files, retain your work and prepare the intended validated bundle in a new directory.</li>
          <li>Keep local plan/report paths printed by the runner. Cleanup with <code>environment remove &lt;workspace&gt;</code> only removes unchanged prepared files after review; plans and reports are retained, and changed or additional files block cleanup.</li>
          <li>Revoke registry client access through <a href={`${api}/account/connections`}>Connections</a>. Disconnect any separately added business adapter at its provider, following its documented procedure.</li>
        </ul>
      </DocsSection>
      <DocsSection id="ai-instructions" title="Ask your AI to help with setup">
        <DocsCopyBlock text={`Help me set up Localfirst project [project-id], exact version [version-id], environment [key].
Read its public requirements and exact bundle through Localfirst MCP at ${api}/mcp.
Keep those immutable IDs and digests throughout setup. Check the installed runner,
runtime, model capabilities, profile, and deployment availability before commands.
Inspect public fixtures first. Explain required private input and dataset shapes,
but keep credentials and customer data in local files outside the public bundle.
Identify missing adapters and unknown integration requirements without inventing them.
Show the exact local plan and resource effects. Wait for my approval of setup,
execution, external writes, and sharing separately; never approve on my behalf.
Inspect actual outputs and failures. Do not treat a fixture pass as live integration evidence.`} />
        <p>For reusable workflow changes, follow <Link href="/docs/environments/create">Create an environment</Link> and publish a distinct version with its own evidence.</p>
      </DocsSection>
    </div>
  );
}
