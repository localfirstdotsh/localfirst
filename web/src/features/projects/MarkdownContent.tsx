import type { ComponentProps, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { safeExternalUrl } from '../../lib/format';

/**
 * Renders a project specification's Markdown (FRONTEND_PRD sections 6.6, 17.2).
 *
 * The content is untrusted. react-markdown builds React elements and never injects
 * HTML, and raw HTML in the source is dropped (`skipHtml`). On top of that:
 * - only http(s) links are links, and they open externally with `nofollow`;
 *   `javascript:`, `data:`, relative, and every other target become plain text;
 * - images are never loaded (no remote fetch from a specification), shown as text;
 * - headings are demoted so the page keeps one h1 and a sensible outline;
 * - code stays text. Nothing here runs, and nothing can change page controls.
 */

const HEADING_LEVEL: Record<string, 'h3' | 'h4' | 'h5' | 'h6'> = {
  h1: 'h3',
  h2: 'h3',
  h3: 'h4',
  h4: 'h5',
  h5: 'h6',
  h6: 'h6',
};

function heading(tag: keyof typeof HEADING_LEVEL) {
  const Tag = HEADING_LEVEL[tag] ?? 'h6';
  return function Heading({ children }: { children?: ReactNode }) {
    return <Tag>{children}</Tag>;
  };
}

function Link({ href, children }: ComponentProps<'a'>) {
  const link = safeExternalUrl(href ?? null);
  if (!link) return <span>{children}</span>;
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer nofollow">
      {children}
      <span className="visually-hidden"> (opens {link.host} in a new tab)</span>
    </a>
  );
}

function Image({ alt }: ComponentProps<'img'>) {
  return <span className="muted">[image{alt ? `: ${alt}` : ''}]</span>;
}

export function MarkdownContent({ source }: { source: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        // The default transform allows more schemes than this site ever links to.
        urlTransform={(url) => (safeExternalUrl(url) ? url : '')}
        components={{
          a: Link,
          img: Image,
          h1: heading('h1'),
          h2: heading('h2'),
          h3: heading('h3'),
          h4: heading('h4'),
          h5: heading('h5'),
          h6: heading('h6'),
          table: ({ children }) => (
            <div className="table-scroll" tabIndex={0} role="region" aria-label="Table, scrollable">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
