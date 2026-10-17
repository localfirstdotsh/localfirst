import { describe, expect, it } from 'vitest';
import { digestOf } from '../canonical.js';
import { parseProjectDocument } from '../project/document.js';
import { projectSpecSchema } from '../project/schema.js';
import { validateProjectBundle } from '../project/validate.js';
import { bakeryBundle } from './bakery.js';
import { bakeryHolidayBundle } from './remix.js';

describe('bakery holiday workflow remix', () => {
  it('preserves the parent and its attribution while giving the changed workflow a distinct identity and fixture', () => {
    const parent = bakeryBundle(), before = structuredClone(parent), remix = bakeryHolidayBundle();
    const checked = validateProjectBundle(remix);
    expect(checked.issues.filter(i => i.severity === 'error')).toEqual([]);
    expect(checked.ok).toBe(true);
    expect(bakeryBundle()).toEqual(before);
    const original = projectSpecSchema.parse(parseProjectDocument(parent.project_md).frontmatter);
    const child = projectSpecSchema.parse(parseProjectDocument(remix.project_md).frontmatter);
    expect(child.derivative_of).toMatchObject({ project_key: original.project.key, version: original.project.version, project_id: null });
    expect(child.derivative_of?.project_version_id).toBeUndefined();
    expect(child.attribution.authors).toEqual(expect.arrayContaining(original.attribution.authors));
    expect(child.sources).toEqual(original.sources);
    expect(child.project.license).toEqual(original.project.license);
    expect(child.evidence).toEqual([]);
    expect(remix.environment.tested_configuration).toEqual(parent.environment.tested_configuration);
    expect(remix.test.environment_digest).toBe(digestOf(remix.environment));
    expect(remix.test.environment_digest).not.toBe(parent.test.environment_digest);
    expect(checked.content_digest).not.toBe(validateProjectBundle(parent).content_digest);
    expect(remix.environment.nodes.slice(0, -1)).toEqual(parent.environment.nodes);
    expect(remix.environment.execution).toEqual(parent.environment.execution);
    expect(remix.environment.model_roles).toHaveLength(4);
    expect(remix.environment.limits).toMatchObject({ max_inference_requests: 4, max_output_tokens: 2048 });
    expect(remix.files.find(f => f.path === 'PROMPTS/intake.txt')).toEqual(parent.files.find(f => f.path === 'PROMPTS/intake.txt'));
    const changed = structuredClone(remix);
    changed.files.find(f => f.path === 'DATA/prices.json')!.content += ' ';
    expect(validateProjectBundle(changed).ok).toBe(false);
  });
});
