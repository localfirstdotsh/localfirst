import assert from 'node:assert/strict';
import { validateProjectBundle } from '@localfirst/contracts';
import { loadConfig, setConfig } from '../config.js';
import { importProjectFromGitHub } from '../sources/github.js';
import { SourceFetchError } from '../sources/safe-fetch.js';

setConfig(loadConfig({
  NODE_ENV: 'test', DATABASE_URL: 'postgres://localhost/postgres',
  API_BASE_URL: 'http://127.0.0.1:8789', WEBSITE_URL: 'http://127.0.0.1:3000',
  AUTH_SECRET: 'unused-source-verification-secret-value',
  ...(process.env.GITHUB_INGESTION_TOKEN ? { GITHUB_INGESTION_TOKEN: process.env.GITHUB_INGESTION_TOKEN } : {}),
}));
const descriptor = { provider: 'github', repository_url: 'https://github.com/octocat/Hello-World', ref: 'master', manifest_path: 'README' };
const results: Array<Record<string, unknown>> = [];
for (const [name, path, expected] of [
  ['ordinary_non_manifest', 'README', 'SOURCE_NOT_ALLOWED'],
  ['missing_file', 'PROJECT.md', 'SOURCE_UNAVAILABLE'],
  ['directory', 'src', 'SOURCE_NOT_ALLOWED'],
] as const) {
  try {
    await importProjectFromGitHub({ ...descriptor, ...(name === 'directory' ? { repository_url: 'https://github.com/microsoft/vscode', ref: 'main' } : {}), manifest_path: path });
    throw new Error(`Expected ${name} to be rejected`);
  } catch (error) {
    if (!(error instanceof SourceFetchError)) throw error;
    assert.equal(error.code, expected);
    if (name === 'missing_file') assert.equal(error.status, 404);
    if (name === 'ordinary_non_manifest') assert.match(error.message, /FRONTMATTER_MISSING/);
    results.push({ case: name, code: error.code, status: error.status, passed: true });
  }
}
// A real public contract fixture can be supplied without publishing anything from this command.
if (process.env.VERIFY_GITHUB_REPOSITORY_URL) {
  const imported = await importProjectFromGitHub({
    provider: 'github', repository_url: process.env.VERIFY_GITHUB_REPOSITORY_URL,
    ref: process.env.VERIFY_GITHUB_REF ?? 'main', manifest_path: process.env.VERIFY_GITHUB_MANIFEST_PATH ?? 'PROJECT.md',
  });
  assert.equal(validateProjectBundle(imported.payload).ok, true, 'The public fixture is not a valid contract bundle');
  results.push({ case: 'public_contract_fixture', commit: imported.repository.resolved_commit,
    files: imported.files_read.length, bytes: imported.bytes_read, passed: true });
}
console.log(JSON.stringify({ verification: 'p0-live-github', results, passed: true,
  limitation: 'Live malformed-document, missing-file, and directory paths only unless a public contract fixture is supplied; provider rate-limit exhaustion is not induced.' }, null, 2));
