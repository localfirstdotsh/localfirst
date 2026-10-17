import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import PrivacyPage from './page';
it('states what is counted, what is stored, and what a count is not', () => {
  const text = renderToStaticMarkup(<PrivacyPage />);
  expect(text).toContain('Nothing identifies who made the requests');
  expect(text).toContain('no account, address, device, browser, token, or search text');
  expect(text).toContain('not a number of people, installs, builds, or runs');
  expect(text).toContain('does not go down when a connection is revoked');
});
