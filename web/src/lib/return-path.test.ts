import { expect, it } from 'vitest';
import { safeReturnPath } from './return-path';
it('allows local continuations and rejects external, protocol-relative, backslash and control-character redirects', () => {
  expect(safeReturnPath('/review/drafts/one?review=again')).toBe('/review/drafts/one?review=again');
  for (const value of ['https://evil.invalid', '//evil.invalid', '/\\evil.invalid', '/path\n', undefined]) expect(safeReturnPath(value)).toBe('/account/connections');
});
