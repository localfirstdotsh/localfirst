import { expect, it } from 'vitest';
import { designSystemEnabled } from './design-system';

it('keeps the component gallery opt-in outside development', () => {
  expect(designSystemEnabled({})).toBe(false);
  expect(designSystemEnabled({ NODE_ENV: 'production' })).toBe(false);
  expect(designSystemEnabled({ LOCALFIRST_DESIGN_SYSTEM: 'true', NODE_ENV: 'production' })).toBe(true);
  expect(designSystemEnabled({ NODE_ENV: 'development' })).toBe(true);
});
