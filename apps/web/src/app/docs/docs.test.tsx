import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bakeryBundle, validateProjectBundle } from '@localfirst/contracts';
import { discoverMcpEndpoint } from '../../lib/mcp-setup';
import { NavLinks } from '../../components/layout/NavLinks';
import DocsLayout from './layout';
import DocsPage from './page';
import ConnectDocsPage from './connect/page';
import ProjectSpecDocsPage from './project-spec/page';
import TestingDocsPage from './testing/page';
import CreateEnvironmentDocsPage from './environments/create/page';
import SetupEnvironmentDocsPage from './environments/setup/page';
import ToolkitPreviewPage from './toolkit/page';

vi.mock('../../lib/mcp-setup', async (original) => ({ ...await original<typeof import('../../lib/mcp-setup')>(), discoverMcpEndpoint: vi.fn(async () => null) }));

const route = vi.hoisted(() => ({ pathname: '/docs' }));
vi.mock('next/navigation', () => ({
  usePathname: () => route.pathname,
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(discoverMcpEndpoint).mockResolvedValue(null);
  route.pathname = '/docs';
});

const guides = [
  ['/docs/connect', ConnectDocsPage],
  ['/docs/project-spec', ProjectSpecDocsPage],
  ['/docs/testing', TestingDocsPage],
  ['/docs/environments/create', CreateEnvironmentDocsPage],
  ['/docs/environments/setup', SetupEnvironmentDocsPage],
] as const;

const currentLink = (html: string) => html.match(/<a\b[^>]*aria-current="page"[^>]*>/g) ?? [];

describe('documentation discovery', () => {
  it('links every implemented guide from the hub and shared navigation', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOCALFIRST_TOOLKIT_PREVIEW', 'false');
    const hub = renderToStaticMarkup(<DocsPage />);
    const navigation = renderToStaticMarkup(<DocsLayout>Guide</DocsLayout>);
    for (const [path, Page] of guides) {
      expect(hub).toContain(`href="${path}"`);
      expect(navigation).toContain(`href="${path}"`);
      const content = renderToStaticMarkup(await Page());
      expect(content.match(/<h1[\s>]/g)).toHaveLength(1);
    }
    expect(currentLink(navigation)).toEqual([expect.stringContaining('href="/docs"')]);
  });

  it.each(['/docs', ...guides.map(([path]) => path), '/docs/toolkit'])(
    'keeps primary Docs navigation active at %s',
    (path) => {
      route.pathname = path;
      expect(currentLink(renderToStaticMarkup(<NavLinks />))).toEqual([expect.stringContaining('href="/docs"')]);
    },
  );

  it('marks only the selected guide as current in shared navigation', () => {
    route.pathname = '/docs/environments/setup';
    const navigation = renderToStaticMarkup(<DocsLayout>Guide</DocsLayout>);
    expect(currentLink(navigation)).toEqual([expect.stringContaining('href="/docs/environments/setup"')]);
  });

  it('omits unavailable toolkit promotion from the public docs', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('LOCALFIRST_TOOLKIT_PREVIEW', 'false');
    const hub = renderToStaticMarkup(<DocsPage />);
    expect(hub).not.toContain('Agent toolkit');
    expect(hub).not.toContain('href="/docs/toolkit"');
    expect(renderToStaticMarkup(<DocsLayout>Guide</DocsLayout>)).not.toContain('href="/docs/toolkit"');
    expect(() => renderToStaticMarkup(<ToolkitPreviewPage />)).toThrow('NEXT_NOT_FOUND');
  });

  it.each([
    ['production', 'true'],
    ['development', 'false'],
  ])('links to the toolkit when preview is enabled (%s, flag %s)', (mode, flag) => {
    vi.stubEnv('NODE_ENV', mode);
    vi.stubEnv('LOCALFIRST_TOOLKIT_PREVIEW', flag);
    expect(renderToStaticMarkup(<DocsPage />)).toContain('href="/docs/toolkit"');
    expect(renderToStaticMarkup(<DocsLayout>Guide</DocsLayout>)).toContain('href="/docs/toolkit"');
    expect(renderToStaticMarkup(<ToolkitPreviewPage />)).toContain('Design preview');
  });

  it('uses the browser-facing deployment origin for connection and schema links', async () => {
    vi.stubEnv('LOCALFIRST_API_URL', 'http://private-api:8787');
    vi.stubEnv('LOCALFIRST_PUBLIC_API_URL', 'https://registry.example');
    vi.mocked(discoverMcpEndpoint).mockResolvedValue('https://registry.example/mcp');
    const connection = renderToStaticMarkup(await ConnectDocsPage());
    expect(connection).toContain('https://registry.example/mcp');
    expect(connection).not.toContain('private-api');
    expect(renderToStaticMarkup(<ProjectSpecDocsPage />)).toContain('https://registry.example/schemas/project/v0.3.json');
  });

  it('presents a valid complete starter with its actual bundle identity and fixture expectations', () => {
    const bundle = bakeryBundle();
    const result = validateProjectBundle({ project_md: bundle.project_md, files: bundle.files });
    expect(result.ok, JSON.stringify(result.issues)).toBe(true);
    const page = renderToStaticMarkup(<CreateEnvironmentDocsPage />);
    expect(page).toContain(result.content_digest);
    for (const file of bundle.files) expect(page).toContain(file.path);
    for (const item of bundle.test.cases) expect(page).toContain(item.key);
    expect(page).toContain('expected outcomes, not an observed report');
  });
});
