import { DigestValue } from './DigestValue';
import { humanize, safeExternalUrl } from '../../lib/format';
import type { VersionDetail, VersionSource } from '../../lib/schemas';

export function VersionSources({ version }: { version: VersionDetail }) {
  return (
    <>
      <section aria-labelledby="attribution" className="stack gap-8">
        <h2 id="attribution">Original authors</h2>
        {version.attribution.authors.length === 0 ? (
          <p className="muted">Not supplied</p>
        ) : (
          <ul className="compact-list">
            {version.attribution.authors.map((author) => (
              <li key={`${author.name}-${author.relationship}`}>
                <ExternalOrText href={author.url} label={author.name} /> <span className="muted">· {humanize(author.relationship)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="sources" className="stack gap-8">
        <h2 id="sources">Sources</h2>
        {version.sources.length === 0 ? (
          <p className="muted">No sources supplied.</p>
        ) : (
          <dl className="definition-list">
            {version.sources.map((source) => (
              <SourceRow key={source.key} source={source} />
            ))}
          </dl>
        )}
      </section>
    </>
  );
}

/** A source link opens externally only for http(s); anything else stays inert text. */
function ExternalOrText({ href, label }: { href: string | null; label: string }) {
  const link = safeExternalUrl(href);
  if (!link) return <span>{label}</span>;
  return (
    <a href={link.href} target="_blank" rel="noopener noreferrer nofollow">
      {label}
      <span className="visually-hidden"> (opens {link.host} in a new tab)</span>
    </a>
  );
}

function SourceRow({ source }: { source: VersionSource }) {
  const link = safeExternalUrl(source.url);
  return (
    <div>
      <dt>{humanize(source.kind)}</dt>
      <dd className="stack gap-8">
        {link ? (
          <a href={link.href} target="_blank" rel="noopener noreferrer nofollow">
            {link.host}
            <span className="visually-hidden"> (opens in a new tab)</span>
          </a>
        ) : source.url ? (
          <span className="mono">{source.url}</span>
        ) : (
          <span>Original authored specification, hosted by Localfirst</span>
        )}
        <span className="small muted">
          {source.pinned ? 'Pinned to a revision' : 'Unpinned: no content digest'}
          {source.revision ? ` · revision ${source.revision}` : ''}
          {' · '}License: {source.license_id ?? humanize(source.license_state ?? 'unknown')}
        </span>
        {source.content_digest && <DigestValue value={source.content_digest} />}
      </dd>
    </div>
  );
}
