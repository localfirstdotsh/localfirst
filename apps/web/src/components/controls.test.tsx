import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button, buttonClassName } from './ui/Button';
import { Input, Select, Checkbox } from './ui/FieldControl';
import { FormField } from './composites/FormField';
import { StatePanel } from './composites/StatePanel';
import { EmptyState } from './composites/EmptyState';
import { DiscoveryError, DiscoveryLoading } from './composites/DiscoveryFeedback';

const html = renderToStaticMarkup;
describe('shared controls and feedback', () => {
  it('supports a borderless empty state with optional icon and action, without alert semantics', () => {
    const out = html(<EmptyState title="Nothing yet" description="Published items appear here." icon={null} />);
    expect(out).toContain('role="status"');
    expect(out).not.toContain('<svg');
    expect(out).not.toContain('role="alert"');
    expect(html(<EmptyState title="Nothing yet" description="Browse the catalog." action={<a href="/projects" className={buttonClassName({ variant: 'primary' })}>Explore</a>} />)).toContain('button-primary');
  });
  it('announces loading and failures separately, retaining a native retry and safe request ID', () => {
    const loading = html(<DiscoveryLoading label="models" />);
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('Loading models');
    const error = html(<DiscoveryError title="Models could not be loaded" description="Try again shortly." retryHref="/models" requestId="req-123" />);
    expect(error).toContain('role="alert"');
    expect(error).toContain('href="/models"');
    expect(error).toContain('Request ID: req-123');
  });
  it('makes accidental form submission opt-in and prevents loading activation', () => {
    expect(html(<Button>Cancel</Button>)).toContain('type="button"');
    const submit = html(<Button type="submit" loading variant="primary">Checking…</Button>);
    expect(submit).toContain('type="submit"');
    expect(submit).toContain('disabled=""');
    expect(submit).toContain('aria-busy="true"');
    expect(buttonClassName({ size: 'small', variant: 'primary' })).toBe('button button-primary button-small');
  });
  it('preserves external form ownership, control names, values and native constraints', () => {
    const input = html(<Input form="search" name="q" type="search" maxLength={200} defaultValue="jetson" />);
    expect(input).toContain('form="search"');
    expect(input).toContain('name="q"');
    expect(input).toContain('maxLength="200"');
    expect(input).toContain('value="jetson"');
    expect(html(<Select name="runtime" defaultValue="ollama"><option value="">Unknown</option><option value="ollama">Ollama</option></Select>)).toContain('selected=""');
    expect(html(<Checkbox form="filters" name="os" value="linux" defaultChecked>Linux</Checkbox>)).toContain('checked=""');
  });
  it('associates labels and error feedback without putting the error in the label', () => {
    const out = html(<FormField id="memory" label="Memory" error="Invalid memory"><Input id="memory" aria-invalid="true" aria-describedby="memory-error" /></FormField>);
    expect(out).toContain('<label class="muted" for="memory">Memory</label>');
    expect(out).toContain('aria-describedby="memory-error"');
    expect(out).toContain('id="memory-error"');
  });
  it('retains live feedback semantics, heading hierarchy and request IDs', () => {
    expect(html(<StatePanel title="Empty" />)).toContain('role="status"');
    const out = html(<StatePanel title="Unavailable" level="h3" tone="warning" requestId="req-1">Try again</StatePanel>);
    expect(out).toContain('role="alert"');
    expect(out).toContain('<h3');
    expect(out).toContain('Request ID: req-1');
    expect(out).toContain('Try again');
  });
});
