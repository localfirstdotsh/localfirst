import './gallery.css';
import { Select as ChoiceSelect } from '../../components/ui/Select';
import { IntegrationGroup } from '../../features/connect/IntegrationGroup';
import { CatalogControls } from '../../features/catalog/CatalogFilters';
import { CatalogResults } from '../../features/catalog/CatalogResults';
import { emptyQuery } from '../../lib/catalog-query';
import { ArtifactInspector } from '../../components/composites/ArtifactInspector';
import { ApplicationIdentity, Permissions } from '../../features/auth';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Button, buttonClassName } from '../../components/ui/Button';
import { Input, Select, Checkbox } from '../../components/ui/FieldControl';
import { Badge } from '../../components/ui/Badge';
import { FormField } from '../../components/composites/FormField';
import { StatePanel } from '../../components/composites/StatePanel';
import { CommandBlock } from '../../components/composites/CommandBlock';
import { PageHeader } from '../../components/composites/PageHeader';
import { PageContainer } from '../../components/layout/PageContainer';
import { DigestValue } from '../../features/projects/DigestValue';
import { EvidenceBadge } from '../../features/projects';
import { designSystemEnabled } from '../../lib/design-system';

export const metadata: Metadata = { title: 'Design system', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

const COLORS = ['bg', 'card', 'fg', 'fg-muted', 'border', 'code', 'accent', 'link', 'warn', 'error', 'success'] as const;

/** Examples import production components. This route owns only the examples, never another component implementation. */
export default async function DesignSystemPage() {
  if (!designSystemEnabled()) notFound();
  return (
    <PageContainer gap={32}>
      <PageHeader title="Design system">
        Production components and tokens. Inter and the shared dark foundation apply to every browser page. Tab through controls to inspect focus,
        hover with a pointer, and use Space or Enter to activate buttons and disclosures.
      </PageHeader>
      <section className="stack gap-16" aria-labelledby="actions">
        <h2 id="actions">Actions</h2>
        <div className="gallery-inline">
          <Button>Default</Button><Button variant="primary">Primary</Button><Button size="small">Small</Button>
          <Button disabled>Disabled</Button><Button variant="primary" loading>Checking…</Button>
          <Link href="/projects" className={buttonClassName()}>Link action</Link>
        </div>
        <p className="small muted">Button defaults to type="button". Use type="submit" for forms and native links for navigation. Loading disables activation and exposes aria-busy.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="fields">
        <h2 id="fields">Form controls</h2>
        <div className="requirements-grid">
          <FormField id="gallery-search" label="Search" help="Controls retain their native keyboard behavior.">
            <Input id="gallery-search" type="search" placeholder="Search projects…" aria-describedby="gallery-search-help" />
          </FormField>
          <FormField id="gallery-runtime" label="Runtime">
            <Select id="gallery-runtime" defaultValue=""><option value="">Unknown</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option></Select>
          </FormField>
          <FormField id="gallery-memory" label="Memory (GiB)" error="Enter a positive number, or leave it blank.">
            <Input id="gallery-memory" type="number" defaultValue="-1" aria-invalid="true" aria-describedby="gallery-memory-error" />
          </FormField>
          <FormField id="gallery-disabled" label="Disabled field"><Input id="gallery-disabled" disabled value="Not available" /></FormField>
        </div>
        <div className="gallery-inline">
          <Checkbox>Optional</Checkbox><Checkbox defaultChecked>Selected</Checkbox><Checkbox disabled>Unavailable</Checkbox>
        </div>
        <p className="small muted">FormField owns labels and feedback; controls own their id, validation and aria-describedby. Keep feature validation in the feature.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="commands">
        <h2 id="commands">Commands and selection</h2>
        <CommandBlock command="example --help" clients={[
          { id: 'default', label: 'Default command', command: 'example --help' },
          { id: 'alternate', label: 'Alternate command', command: 'example --version' },
        ]} note="Demonstration text. Copy it to inspect clipboard feedback; nothing is executed." />
        <p className="small muted">Selection uses aria-pressed. Copy reports success only after clipboard access succeeds; a denied clipboard selects text for manual copying.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="surfaces">
        <h2 id="surfaces">Surfaces and feedback</h2>
        <div className="card-grid">
          <div className="panel stack gap-8"><h3 className="section-title">Card surface</h3><p className="muted">Use the shared panel surface; content and actions belong to the owning feature.</p><div><Badge>Metadata</Badge></div></div>
          <StatePanel title="No records yet" level="h3">Explain how real records appear here.</StatePanel>
          <StatePanel title="Could not load records" tone="warning" level="h3" requestId="example-request">Keep recovery actions visible. <Link href="/projects">Try the catalog</Link></StatePanel>
        </div>
        <div className="gallery-inline"><EvidenceBadge level="claimed" /><EvidenceBadge level="documented" /><EvidenceBadge level="reproducible_test" /></div>
        <p className="small muted">StatePanel uses status for neutral feedback and alert for warnings. EvidenceBadge belongs to projects and always carries a text label.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="disclosures">
        <h2 id="disclosures">Disclosure</h2>
        <DigestValue value={`sha256:${'a'.repeat(64)}`} />
        <p className="small muted">Native details provides keyboard expansion. Full digests stay selectable. The catalog also uses native details for its responsive filters.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="foundations">
        <h2 id="foundations">Typography, color and spacing</h2>
        <div className="panel stack gap-8"><h3>Section heading</h3><p>Body text</p><p className="small muted">Supporting text</p><code>Monospace text</code></div>
        <div className="gallery-colors">{COLORS.map((color) => <div key={color} className="stack gap-8"><span className={`gallery-swatch swatch-${color}`} aria-hidden="true" /><code className="small">--{color}</code></div>)}</div>
        <div className="gallery-inline">{[8, 16, 24, 32].map((space) => <div key={space} className={`gallery-spacing gap-${space}`}><span /><span /><code>{space}px gap</code></div>)}</div>
        <p className="small muted">Use design-system/tokens.css for semantic colors, font scales, spacing, widths, radii and layers. Use flat surfaces and immediate state changes, matching the existing interface.</p>
      </section>
      <section className="stack gap-16" aria-labelledby="browser-patterns">
        <h2 id="browser-patterns">Application permissions and exact-text inspection</h2>
        <div className="panel stack gap-16"><ApplicationIdentity name="Example application" /><Permissions scopes={['projects:read', 'custom:scope']} descriptions={{ 'projects:read': 'Read the public catalog and compatibility information.' }} /></div>
        <ArtifactInspector content="Example artifact text. This reference performs no approval or publication." label="Inspect example artifact" />
      </section>
      <section className="stack gap-16" aria-labelledby="catalog-controls"><h2 id="catalog-controls">Discovery controls</h2><ChoiceSelect name="example" label="Example select" defaultValue="recent" options={[{ value: 'recent', label: 'Recently updated' }, { value: 'evidence', label: 'Recent evidence' }]} /><CatalogControls query={emptyQuery()} /></section>
      <section className="stack gap-16" aria-labelledby="live-projects"><h2 id="live-projects">Project row &amp; evidence</h2><CatalogResults query={emptyQuery()} preview /></section>
      <IntegrationGroup />
    </PageContainer>
  );
}
