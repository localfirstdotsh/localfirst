import { MarkdownContent } from './MarkdownContent';

export function VersionDocumentation({ markdown }: { markdown: string }) {
  return (
    <section aria-labelledby="spec" className="stack gap-16">
      <h2 id="spec">Documentation</h2>
      <p className="small muted">
        The documentation for this exact version. Links open in a new tab; images and embedded HTML from the
        specification are never loaded.
      </p>
      <div className="panel">
        <MarkdownContent source={markdown} />
      </div>
      <details>
        <summary className="document-summary">View the raw PROJECT.md text</summary>
        <pre
          tabIndex={0}
          aria-label="Raw PROJECT.md contents, scrollable"
          className="panel mono small document-raw"
        >
          {markdown}
        </pre>
      </details>
    </section>
  );
}
