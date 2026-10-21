import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import BuildsPage from './page';

afterEach(() => vi.unstubAllEnvs());

it('labels global build discovery as upcoming without claiming that public builds do not exist', () => {
  vi.stubEnv('LOCALFIRST_CATALOG_PREVIEW', 'true');
  const out = renderToStaticMarkup(<BuildsPage />);
  expect(out).toContain('Explore how local AI projects are configured and run.');
  expect(out).toContain('Build discovery is coming soon');
  expect(out).toContain('Browse projects');
  expect(out).toContain('href="/projects"');
  expect(out).not.toContain('No builds yet');
  expect(out).not.toContain('Public build records are not available');
});
