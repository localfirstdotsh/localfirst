import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent } from './MarkdownContent';

const html = (source: string) => renderToStaticMarkup(<MarkdownContent source={source} />);

describe('MarkdownContent', () => {
  it('renders ordinary Markdown structure', () => {
    const out = html('# Title\n\nSome **bold** text.\n\n- one\n- two\n\n```\ncode\n```');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<pre><code>code');
  });

  it('drops raw HTML instead of rendering it', () => {
    const out = html('hello <script>alert(1)</script> <iframe src="https://evil.example"></iframe> <b onclick="x()">b</b>');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('<iframe');
    expect(out).not.toContain('onclick');
    expect(out).toContain('hello');
  });

  it('turns every non-http(s) link into inert text', () => {
    for (const target of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '/relative', '#anchor', 'mailto:a@b.co', 'file:///etc/passwd']) {
      const out = html(`[click](${target})`);
      expect(out, target).not.toContain('<a ');
      expect(out, target).not.toContain('href');
      expect(out, target).toContain('click');
    }
  });

  it('opens http(s) links externally without leaking the opener or passing rank', () => {
    const out = html('[docs](https://example.org/docs)');
    expect(out).toContain('href="https://example.org/docs"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('never loads an image from a specification', () => {
    const out = html('![tracking pixel](https://tracker.example/p.gif)\n\n<img src="https://tracker.example/q.gif">');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('tracker.example');
    expect(out).toContain('[image: tracking pixel]');
  });

  it('demotes headings so the page keeps a single h1', () => {
    const out = html('# One\n## Two\n### Three');
    expect(out).not.toContain('<h1');
    expect(out).not.toContain('<h2');
    expect(out).toContain('<h3>One</h3>');
    expect(out).toContain('<h3>Two</h3>');
    expect(out).toContain('<h4>Three</h4>');
  });

  it('renders tables in a labelled scroll region', () => {
    const out = html('| a | b |\n| - | - |\n| 1 | 2 |');
    expect(out).toContain('role="region"');
    expect(out).toContain('<table>');
  });
});
