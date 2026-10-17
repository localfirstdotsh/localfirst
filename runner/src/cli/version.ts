import { readFileSync } from 'node:fs';

/** The runner release, read once from this package's own manifest. */
export const RUNNER_VERSION: string = (() => {
  try {
    const url = new URL('../../package.json', import.meta.url);
    return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0-unknown';
  }
})();
