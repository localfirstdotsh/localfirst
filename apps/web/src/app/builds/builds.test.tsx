import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import BuildsPage from './page';

it('labels global build discovery as upcoming without claiming that public builds do not exist', () => {
  const out = renderToStaticMarkup(<BuildsPage />);
  expect(out).toContain('Explore how local AI projects are configured and run.');
  expect(out).toContain('Build discovery is coming soon');
  expect(out).toContain('Browse projects');
  expect(out).toContain('href="/projects"');
  expect(out).not.toContain('No builds yet');
  expect(out).not.toContain('Public build records are not available');
});
