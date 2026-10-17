import { EXAMPLE_TEST_YAML } from '@localfirst/contracts';
import { describe, expect, it } from 'vitest';
import { verifyForExecution, type VerificationReason } from '../src/index.js';
import { bundleWithTestYaml, exampleBundle, planFor } from './helpers.js';

const plan = planFor();
const base = { plan, bundle: exampleBundle, approvedPlanDigest: plan.plan_digest };

function reasonsOf(input: Parameters<typeof verifyForExecution>[0]): VerificationReason[] {
  const result = verifyForExecution(input);
  return result.ok ? [] : result.reasons;
}

describe('verifyForExecution', () => {
  it('accepts the approved plan against the unchanged bundle', () => {
    const result = verifyForExecution(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.manifest.key).toBe('request-label-v1');
  });

  it('is invalidated by an edit to a fixture prompt', () => {
    const edited = EXAMPLE_TEST_YAML.replace('Please explain the charge on my invoice.', 'Please cancel my account.');
    expect(edited).not.toBe(EXAMPLE_TEST_YAML);
    const reasons = reasonsOf({ ...base, bundle: bundleWithTestYaml(edited) });
    expect(reasons).toEqual(expect.arrayContaining(['bundle_digest_mismatch', 'manifest_digest_mismatch', 'fixture_digest_mismatch']));
    expect(reasons).not.toContain('evaluator_digest_mismatch');
  });

  it('is invalidated by an edit to the evaluator', () => {
    const edited = EXAMPLE_TEST_YAML.replace('equals: billing', 'equals: support');
    const reasons = reasonsOf({ ...base, bundle: bundleWithTestYaml(edited) });
    expect(reasons).toEqual(expect.arrayContaining(['bundle_digest_mismatch', 'manifest_digest_mismatch', 'evaluator_digest_mismatch']));
    expect(reasons).not.toContain('fixture_digest_mismatch');
  });

  it('is invalidated by an edit to the project source text', () => {
    const reasons = reasonsOf({
      ...base,
      bundle: { ...exampleBundle, project_md: exampleBundle.project_md.replace('Label a short customer request', 'Label a long customer request') },
    });
    expect(reasons).toEqual(['bundle_digest_mismatch']);
  });

  it('is invalidated by a change to settings that the plan did not approve', () => {
    const edited = EXAMPLE_TEST_YAML.replace('temperature: 0', 'temperature: 1');
    expect(reasonsOf({ ...base, bundle: bundleWithTestYaml(edited) })).toContain('settings_mismatch');
    const drifted = planFor(undefined, (body) => (body.settings.temperature = 0.7));
    expect(reasonsOf({ ...base, plan: drifted, approvedPlanDigest: drifted.plan_digest })).toEqual(['settings_mismatch']);
  });

  it('rejects a bundle that turns on tools, project code, or downloads', () => {
    for (const field of ['allow_tools', 'allow_project_code', 'allow_downloads']) {
      const edited = EXAMPLE_TEST_YAML.replace(`${field}: false`, `${field}: true`);
      expect(verifyForExecution({ ...base, bundle: bundleWithTestYaml(edited) }).ok, field).toBe(false);
    }
  });

  it('rejects a tampered plan', () => {
    const tampered = structuredClone(plan) as any;
    tampered.model.runtime_model_id = 'something-else:latest';
    expect(reasonsOf({ ...base, plan: tampered })).toEqual(['plan_invalid']);
    expect(reasonsOf({ ...base, plan: { not: 'a plan' } })).toEqual(['plan_invalid']);
  });

  it('requires an approval bound to this exact digest', () => {
    expect(reasonsOf({ ...base, approvedPlanDigest: null })).toEqual(['approval_missing']);
    expect(reasonsOf({ ...base, approvedPlanDigest: `sha256:${'0'.repeat(64)}` })).toEqual(['approval_mismatch']);
  });

  it('refuses withdrawn definitions', () => {
    expect(reasonsOf({ ...base, registry: { withdrawn: true } })).toEqual(['withdrawn']);
    expect(verifyForExecution({ ...base, registry: { withdrawn: false } }).ok).toBe(true);
  });

  it('reports a plan for a test the bundle does not contain', () => {
    const other = planFor(undefined, (body) => (body.test.key = 'other-test-v1'));
    expect(reasonsOf({ ...base, plan: other, approvedPlanDigest: other.plan_digest })).toEqual(['test_not_found']);
  });

  it('rejects a bundle that does not validate', () => {
    expect(reasonsOf({ ...base, bundle: { project_md: '# not a project', files: [] } })).toEqual(['bundle_invalid']);
  });

  it('rejects a plan whose role or configuration does not match the test', () => {
    const wrongRole = planFor(undefined, (body) => (body.model.role = 'summarizer'));
    expect(reasonsOf({ ...base, plan: wrongRole, approvedPlanDigest: wrongRole.plan_digest })).toEqual(['test_mismatch']);
  });
});
