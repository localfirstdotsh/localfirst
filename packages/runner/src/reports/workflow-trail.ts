import {
  digestOf, validateProjectBundle, workflowDigests, workflowLocalReportSchema,
  type WorkflowLocalReport,
} from '@localfirst/contracts';
import { mapInputs, readPointer } from '../workflows/state.js';
import { applyPrivateData } from '../workflows/private-data.js';

export interface WorkflowLifecycleEvent {
  kind: 'setup' | 'mcp' | 'approval' | 'command' | 'cleanup';
  timestamp?: string;
  summary: string;
  details?: unknown;
}
export interface WorkflowTrailOptions {
  includePrivate?: boolean;
  lifecycle?: WorkflowLifecycleEvent[];
}
interface AssertionTrail {
  path: string; expected: unknown; actual: unknown;
  result: 'match' | 'mismatch' | 'unavailable' | 'not_evaluated';
}
interface StepTrail {
  id: string; kind: 'agent' | 'operation'; outcome: string;
  latency_ms: number | null; error_code: string | null;
  declared: unknown; inputs: unknown;
  request: { provenance: string; system: string; user: string } | null;
  reconstruction: string; output: unknown;
}
export interface WorkflowTrail {
  schema: 'localfirst/local-workflow-trail/v0.1';
  privacy: { local_only: true; data_class: 'public_fixture' | 'private_local'; content_included: boolean; notice: string };
  summary: {
    run_id: string; state: string; completed_at: string; elapsed_ms: number;
    cases: number; reported_outcomes: Record<string, number>;
    evaluated_assertions: number; matched_assertions: number; mismatched_assertions: number;
    assertion_accuracy: string; caveats: string[];
  };
  setup: unknown;
  lifecycle: Array<{ sequence: number; kind: string; timestamp: string | null; summary: string; details: unknown; provenance: string }>;
  cases: Array<{ key: string; reported_outcome: string; elapsed_ms: number; error_code: string | null; input: unknown; output: unknown; assertions: AssertionTrail[]; steps: StepTrail[] }>;
}

const REDACTED = '[redacted]';
const sensitiveKey = /authorization|cookie|password|passwd|secret|credential|api[-_]?key|^(?:token|(?:access|refresh|id|auth)[-_]?token)$|bearer/i;
const secretText = /\b(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,})/gi;
function safeText(value: string, limit = 4000): string {
  return value.replace(secretText, REDACTED).replace(/\b(authorization|api[_-]?key|password|secret|access[_-]?token)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]').slice(0, limit);
}
/** Lifecycle payloads are observations from the caller, never unrestricted headers or logs. */
function sanitizeEvent(value: unknown, depth = 0, seen = new Set<object>(), budget = { nodes: 1000, characters: 48000 }): unknown {
  if (--budget.nodes < 0 || budget.characters <= 0) return '[event size limit]';
  if (depth > 8) return '[depth limit]';
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') { const text = safeText(value, Math.min(4000, budget.characters)); budget.characters -= text.length; return text; }
  if (typeof value !== 'object') return '[unavailable]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = Array.isArray(value)
    ? value.slice(0, 100).map(v => sanitizeEvent(v, depth + 1, seen, budget))
    : Object.fromEntries(Object.entries(value).slice(0, 100).filter(([k]) => !['__proto__', 'prototype', 'constructor'].includes(k)).map(([k, v]) => [safeText(k, 200), sensitiveKey.test(k) ? REDACTED : sanitizeEvent(v, depth + 1, seen, budget)]));
  seen.delete(value);
  return output;
}
function knownTime(value?: string): string | null {
  return value !== undefined && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
}

/** A local inspection artifact. It is deliberately separate from sanitized registry evidence. */
export function workflowTrail(raw: WorkflowLocalReport, bundle: { project_md: string; files: { path: string; content: string }[] }, options: WorkflowTrailOptions = {}): WorkflowTrail {
  const report = workflowLocalReportSchema.parse(raw), { plan, run } = report;
  const validated = validateProjectBundle(bundle);
  if (!validated.ok || validated.content_digest !== plan.bundle_digest) throw new Error('Trace bundle does not match the recorded bundle digest.');
  const publicEnv = validated.environments?.find(e => e.manifest.key === plan.environment_key)?.manifest;
  const test = validated.workflow_tests?.find(t => t.manifest.key === plan.test.key)?.manifest;
  if (!publicEnv || !test || digestOf(publicEnv) !== plan.environment_digest || test.environment_key !== publicEnv.key ||
    Object.entries(workflowDigests(test)).some(([key, value]) => plan.test[key as keyof typeof plan.test] !== value)) throw new Error('Trace environment or test does not match the recorded plan.');
  const effective = applyPrivateData(publicEnv, new Map(bundle.files.map(f => [f.path, f.content])), report.private_context?.data);
  if (digestOf(effective.environment) !== digestOf(report.environment)) throw new Error('Trace private business data does not match the recorded environment.');
  const privateRun = plan.data_class === 'private_local';
  const include = !privateRun || options.includePrivate === true;
  const env = report.environment;
  const outcomes: Record<string, number> = { pass: 0, fail: 0, error: 0, skipped: 0 };
  const cases: WorkflowTrail['cases'] = run.cases.map(record => {
    if (record.steps.some((step, index) => env.nodes[index]?.id !== step.id || env.nodes[index]?.kind !== step.kind)) throw new Error('Trace recorded steps do not match the declared graph order.');
    outcomes[record.outcome] = (outcomes[record.outcome] ?? 0) + 1;
    const fixture = test.cases.find(c => c.key === record.key);
    if (!privateRun && !fixture) throw new Error('Trace report has an unknown public fixture.');
    const input = privateRun && report.private_context?.input != null ? report.private_context.input : fixture?.input;
    const state = new Map<string, unknown>([['input', input]]);
    for (const data of env.data) state.set('data:' + data.key, JSON.parse(effective.files.get(data.path)!));
    const steps: StepTrail[] = env.nodes.map(node => {
      const actual = record.steps.find(s => s.id === node.id);
      const step: StepTrail = {
        id: node.id, kind: node.kind, outcome: actual?.outcome ?? 'not_recorded', latency_ms: actual?.latency_ms ?? null,
        error_code: actual?.error_code ?? null, declared: node, inputs: null, request: null,
        reconstruction: include ? 'not_attempted' : 'private_content_redacted', output: include ? actual?.output ?? null : REDACTED,
      };
      if (include && actual && actual.outcome !== 'skipped') {
        try {
          step.inputs = mapInputs(node.inputs, state);
          step.reconstruction = 'reconstructed_from_declared_inputs_and_recorded_completed_outputs';
          if (node.kind === 'agent') {
            const prompt = env.prompts.find(p => p.key === node.prompt)!;
            step.request = { provenance: 'reconstruction; transport receipt is not recorded in the local report', system: effective.files.get(prompt.path)!, user: JSON.stringify(step.inputs) };
          }
        } catch { step.reconstruction = 'unavailable_upstream_state'; }
      }
      if (actual?.outcome === 'completed') state.set('node:' + node.id, actual.output);
      return step;
    });
    const assertions: AssertionTrail[] = privateRun ? [] : fixture!.assertions.map(assertion => {
      const item: AssertionTrail = { path: assertion.path, expected: assertion.equals, actual: null, result: 'not_evaluated' };
      if (record.outcome === 'pass' || record.outcome === 'fail') {
        try { item.actual = readPointer(record.output, assertion.path); item.result = item.actual === item.expected ? 'match' : 'mismatch'; }
        catch { item.result = 'unavailable'; }
      }
      return item;
    });
    return { key: record.key, reported_outcome: privateRun && record.outcome === 'pass' ? 'structural_checks_completed' : record.outcome, elapsed_ms: record.elapsed_ms, error_code: record.error_code, input: include ? input ?? null : REDACTED, output: include ? record.output : REDACTED, assertions, steps };
  });
  const assertions = cases.flatMap(c => c.assertions);
  const matched = assertions.filter(a => a.result === 'match').length;
  const mismatched = assertions.filter(a => a.result === 'mismatch' || a.result === 'unavailable').length;
  return {
    schema: 'localfirst/local-workflow-trail/v0.1',
    privacy: { local_only: true, data_class: plan.data_class, content_included: include, notice: 'Local inspection artifact: may contain prompts, customer inputs and business data. Review before sharing. This is not a sanitized registry upload.' },
    summary: { run_id: report.client_run_id, state: run.state, completed_at: report.completed_at, elapsed_ms: run.elapsed_ms, cases: cases.length, reported_outcomes: privateRun ? { ...outcomes, structural_checks_completed: outcomes.pass ?? 0, pass: 0 } : outcomes,
      evaluated_assertions: matched + mismatched, matched_assertions: matched, mismatched_assertions: mismatched,
      assertion_accuracy: privateRun ? 'not_evaluated_private_input' : `${matched}/${matched + mismatched} evaluated assertions matched`,
      caveats: ['Recorded outcomes are shown separately from assertions recomputed against the recorded final output.', 'Reconstructed requests show declared prompts and inputs; they are not proof that a provider received them.', 'Lifecycle entries, when supplied, are caller-provided observations; missing entries mean no event was recorded.', 'Per-step absolute timestamps, approval receipts, raw invalid replies and model chain-of-thought are not recorded by this report.', ...(privateRun ? ['Private runs use structural checks; public fixture accuracy is not evaluated.'] : [])] },
    setup: {
      project: plan.project, project_document: include ? bundle.project_md : REDACTED,
      bundle_digest: plan.bundle_digest, environment_digest: plan.environment_digest, plan_digest: plan.plan_digest,
      plan_created_at: plan.created_at, runner: plan.runner,
      runtime: { family: plan.runtime.family, application_version: plan.runtime.application_version, cli_version: plan.runtime.cli_version, engine_version: plan.runtime.engine_version, adapter_profile: plan.runtime.adapter_profile },
      model_bindings: plan.bindings, effects: plan.effects, graph: env.nodes, graph_output: env.output, limits: env.limits,
      framework: plan.framework ? { profile: plan.framework.profile, sdk_version: plan.framework.sdk_version, entry_digest: plan.framework.entry_digest, lock_digest: plan.framework.lock_digest, worker_digest: plan.framework.worker_digest, image_id: plan.framework.image_id } : null,
      prompts: env.prompts.map(p => ({ ...p, content: include ? effective.files.get(p.path) : REDACTED })),
      data: env.data.map(d => ({ ...d, content: include ? JSON.parse(effective.files.get(d.path)!) : REDACTED })),
      test: { key: test.key, definition_id: plan.test.definition_id, ...workflowDigests(test), fixture_kind: test.fixture_kind, assertions: privateRun ? 'not_evaluated_for_private_run' : 'shown_per_case' },
      locality: report.locality, offline: report.offline,
    },
    lifecycle: (options.lifecycle ?? []).slice(0, 200).map((event, index) => {
      const details = include ? sanitizeEvent(event.details ?? null) : REDACTED;
      return { sequence: index + 1, kind: ['setup', 'mcp', 'approval', 'command', 'cleanup'].includes(event.kind) ? event.kind : 'unknown', timestamp: knownTime(event.timestamp), summary: include ? safeText(event.summary) : 'Private lifecycle event details redacted', details: JSON.stringify(details).length <= 65536 ? details : '[event size limit]', provenance: 'caller_supplied_observation' };
    }),
    cases,
  };
}

function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
const pretty = (value: unknown) => `<pre>${escapeHtml(JSON.stringify(value, null, 2) ?? 'null')}</pre>`;
export function renderWorkflowTrailHtml(trail: WorkflowTrail): string {
  const summary = trail.summary;
  const outcomes = Object.entries(summary.reported_outcomes).map(([key, count]) => `${count} ${key.replaceAll('_', ' ')}`).join(' · ');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Local workflow trail — ${escapeHtml(summary.run_id)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:1120px;margin:32px auto;padding:0 20px;color:#172b38;background:#f6f8fa}h1,h2,h3{line-height:1.2}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff;padding:16px;border:1px solid #ccd6de;border-radius:8px;font:13px/1.5 ui-monospace,monospace}details{margin:12px 0}summary{cursor:pointer;padding:8px;background:#e5edf2}.notice{border-left:5px solid #c17b16;padding:12px;background:#fff4de}.status{font-weight:700}small{color:#465c6b}</style></head><body><h1>Local workflow run trail</h1><p class="notice">${escapeHtml(trail.privacy.notice)}</p><p class="status">${escapeHtml(summary.state)} · ${escapeHtml(String(summary.cases))} cases · ${escapeHtml(summary.assertion_accuracy)}</p><p>${escapeHtml(outcomes)}</p><h2>Run summary</h2>${pretty(summary)}<details><summary>Project, environment, model, settings and declared prompts</summary>${pretty(trail.setup)}</details><h2>Observed setup and MCP lifecycle</h2><p>Caller-supplied observations. Only recorded events appear below; they are not cryptographic proof of execution.</p>${trail.lifecycle.length ? trail.lifecycle.map(e => `<details><summary>${escapeHtml(String(e.sequence))}. ${escapeHtml(e.kind)} — ${escapeHtml(e.summary)}</summary>${pretty(e)}</details>`).join('') : '<p>No external setup, MCP, approval or cleanup events were supplied.</p>'}<h2>Test inputs, requests and results</h2>${trail.cases.map(c => `<section><h3>${escapeHtml(c.key)} — ${escapeHtml(c.reported_outcome)}</h3>${pretty({ elapsed_ms: c.elapsed_ms, error_code: c.error_code, input: c.input, output: c.output, assertions: c.assertions })}${c.steps.map(s => `<details><summary>${escapeHtml(s.id)} · ${escapeHtml(s.kind)} · ${escapeHtml(s.outcome)}</summary>${pretty(s)}</details>`).join('')}</section>`).join('')}<p><small>Local trail schema: ${escapeHtml(trail.schema)}. Prompts contain instructions for the tested model; this viewer treats every value as text.</small></p></body></html>\n`;
}
