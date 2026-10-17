import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOLKIT_TASKS, toolkitPreviewEnabled } from './toolkit';

describe('toolkitPreviewEnabled', () => {
  it('is off unless explicitly enabled or running next dev', () => {
    expect(toolkitPreviewEnabled({})).toBe(false);
    expect(toolkitPreviewEnabled({ NODE_ENV: 'production' })).toBe(false);
    expect(toolkitPreviewEnabled({ LOCALFIRST_TOOLKIT_PREVIEW: 'yes' })).toBe(false);
  });

  it('turns on with the flag or in development', () => {
    expect(toolkitPreviewEnabled({ LOCALFIRST_TOOLKIT_PREVIEW: 'true', NODE_ENV: 'production' })).toBe(true);
    expect(toolkitPreviewEnabled({ NODE_ENV: 'development' })).toBe(true);
  });
});

describe('TOOLKIT_TASKS', () => {
  it('has exactly one entry per reference file in the skill', () => {
    const dir = resolve(import.meta.dirname, '..', '..', '..', 'skills', 'localfirst', 'references');
    const files = readdirSync(dir).map((f) => f.replace(/\.md$/, '')).sort();
    expect(TOOLKIT_TASKS.map((t) => t.reference).sort()).toEqual(files);
  });
});
