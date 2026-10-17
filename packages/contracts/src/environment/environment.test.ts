import { describe, it, expect } from 'vitest';
import { bakeryBundle } from './bakery.js';
import { validateProjectBundle } from '../project/validate.js';
import { environmentSchema, checkJson, workflowTestSchema } from './schema.js';
import { digestOf } from '../canonical.js';

describe('creator environment contract', () => {
  it('publishes the complete sample with all prompts/data/tests bound into its digest', () => {
    const sample = bakeryBundle(), validated = validateProjectBundle(sample);
    expect(validated.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(validated.environments).toHaveLength(1);
    expect(validated.workflow_tests).toHaveLength(1);
    const changed = structuredClone(sample);
    changed.files.find(f => f.path === 'PROMPTS/intake.txt')!.content += ' changed';
    expect(validateProjectBundle(changed).issues.some(i => i.code === 'ENVIRONMENT_INVALID')).toBe(true);
  });
  it('rejects cycles, forward references, duplicate identities and excessive budgets', () => {
    const { environment } = bakeryBundle();
    const cycle = structuredClone(environment);
    cycle.nodes[0]!.inputs = { message: { source: 'node:quote', path: '' } };
    expect(environmentSchema.safeParse(cycle).success).toBe(false);
    const duplicate = structuredClone(environment); duplicate.nodes[1]!.id = duplicate.nodes[0]!.id;
    expect(environmentSchema.safeParse(duplicate).success).toBe(false);
    const budget = structuredClone(environment); budget.limits.max_output_tokens = 1;
    expect(environmentSchema.safeParse(budget).success).toBe(false);
  });
  it('rejects unreferenced scripts and prototype/depth abuse', () => {
    const sample = bakeryBundle();
    sample.files.push({ path: 'run.js', content: 'process.exit(0)' });
    expect(validateProjectBundle(sample).ok).toBe(false);
    expect(checkJson(JSON.parse('{"__proto__":{"polluted":true}}'))).toBe(false);
    let deep: unknown = 0;
    for (let i = 0; i < 15; i++) deep = [deep];
    expect(checkJson(deep)).toBe(false);
  });
  it('refuses changed test identities and duplicate fixture cases', () => {
    const sample = bakeryBundle();
    const changed = structuredClone(sample.test);
    changed.environment_digest = digestOf('another environment');
    sample.files.find(f => f.path === 'TESTS/bakery-workflow.yaml')!.content = JSON.stringify(changed);
    expect(validateProjectBundle(sample).ok).toBe(false);
    changed.cases.push(changed.cases[0]!);
    expect(workflowTestSchema.safeParse(changed).success).toBe(false);
  });
});
