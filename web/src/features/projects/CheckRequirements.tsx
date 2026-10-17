'use client';

import { Button } from '../../components/ui/Button';

import { useActionState } from 'react';
import { CPU_ARCHITECTURES, OPERATING_SYSTEMS, RUNTIME_FAMILIES } from '@localfirst/contracts';
import { runCheck, type CheckState } from './check-action';
import { humanize } from '../../lib/format';
import { CompatibilityResult } from './CompatibilityResult';
import { Select as SharedSelect } from '../../components/ui/Select';
import { FormField } from '../../components/composites/FormField';
import { Input, Checkbox } from '../../components/ui/FieldControl';
import { StatePanel } from '../../components/composites/StatePanel';

const IDLE: CheckState = { status: 'idle' };

/**
 * Voluntary requirements check (FRONTEND_PRD section 6.3). Every field starts as
 * unknown; the website never detects hardware, models, or runtime versions. The
 * viewed version is pinned in the form.
 */
export function CheckRequirements({ projectId, versionId }: { projectId: string; versionId: string }) {
  const [state, action, pending] = useActionState(runCheck, IDLE);

  return (
    <section aria-labelledby="check" className="stack gap-16">
      <div className="stack gap-8">
        <h2 id="check">Check requirements</h2>
        <p className="small muted">
          Optional. Enter only what you choose to share; leave anything blank if you don&apos;t know it. Nothing is
          detected from your browser or stored.
        </p>
      </div>

      <form action={action} className="panel stack gap-16">
        <input type="hidden" name="project_id" value={projectId} />
        <input type="hidden" name="project_version_id" value={versionId} />
        <div className="requirements-grid">
          <Select name="cpu_architecture" label="CPU architecture" options={CPU_ARCHITECTURES.map((v) => [v, v])} />
          <Select name="os" label="Operating system" options={OPERATING_SYSTEMS.map((v) => [v, humanize(v)])} />
          <Select name="runtime_family" label="Runtime" options={RUNTIME_FAMILIES.map((v) => [v, humanize(v)])} />
          <Select
            name="unified_memory"
            label="Unified memory"
            options={[
              ['yes', 'Yes'],
              ['no', 'No'],
            ]}
          />
          <NumberField name="memory_gib" label="System memory (GiB)" />
          <NumberField name="vram_gib" label="Discrete GPU memory (GiB)" />
        </div>
        <div className="stack gap-8">
          <Checkbox name="require_local">Inference must stay on this machine</Checkbox>
          <Checkbox name="require_offline">It must work offline</Checkbox>
        </div>
        <div>
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? 'Checking…' : 'Check'}
          </Button>
        </div>
      </form>

      <div aria-live="polite">
        {state.status === 'error' && (
          <StatePanel title="The check did not run" tone="warning" requestId={state.requestId} level="h3">
            {state.message}
          </StatePanel>
        )}
        {state.status === 'done' && <CompatibilityResult assessment={state.assessment} />}
      </div>
    </section>
  );
}

function Select({ name, label, options }: { name: string; label: string; options: Array<[string, string]> }) {
  return (
    <div className="stack gap-8 small">
      <span className="muted">{label}</span>
      <SharedSelect name={name} label={label} options={[{ value: '', label: 'Unknown' }, ...options.map(([value, text]) => ({ value, label: text }))]} />
    </div>
  );
}

function NumberField({ name, label }: { name: string; label: string }) {
  return (
    <FormField id={name} label={label}>
      <Input
        id={name}
        name={name}
        type="number"
        inputMode="decimal"
        min="0"
        step="any"
        placeholder="Unknown"
      />
    </FormField>
  );
}
