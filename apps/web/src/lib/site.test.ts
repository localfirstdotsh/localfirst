import { describe, expect, it } from 'vitest';
import { siteUrl } from './site';

describe('siteUrl', () => {
  it('defaults to the local dev origin', () => {
    expect(siteUrl({})).toBe('http://localhost:3000');
  });

  it('returns the bare origin, dropping any path or query', () => {
    expect(siteUrl({ LOCALFIRST_SITE_URL: 'https://localfirst.sh/some/path?x=1' })).toBe('https://localfirst.sh');
  });

  it('rejects a value that is not an absolute http(s) URL', () => {
    for (const value of ['not a url', 'ftp://localfirst.sh', 'javascript:alert(1)', '/relative']) {
      expect(() => siteUrl({ LOCALFIRST_SITE_URL: value }), value).toThrow(/absolute http\(s\) URL/);
    }
  });
});
