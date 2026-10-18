import Link from 'next/link';

/**
 * The one search input. It belongs to a GET form, so Enter submits it and the text lives in the
 * URL. The clear action is a link, so it works without JavaScript. The submit button is out of
 * the tab order: Enter in the field is the keyboard path, and a visible Search button would
 * only repeat it.
 */
export function SearchField({ defaultValue, clearHref }: { defaultValue: string; clearHref: string }) {
  return (
    <div className="search-field">
      <svg className="search-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <circle cx="7" cy="7" r="4.75" stroke="currentColor" strokeWidth="1.5" />
        <path d="M10.5 10.5 14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      <label className="visually-hidden" htmlFor="q">
        Search projects
      </label>
      <input id="q" name="q" type="search" defaultValue={defaultValue} placeholder="Search local AI projects…" maxLength={200} autoComplete="off" />
      {defaultValue && (
        <Link href={clearHref} className="search-clear" aria-label="Clear search">
          ✕
        </Link>
      )}
      <button type="submit" className="visually-hidden" tabIndex={-1}>
        Search
      </button>
    </div>
  );
}
