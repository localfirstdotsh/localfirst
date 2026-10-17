/**
 * The registry is untrusted input to the runner (BACKEND_PRD section 17.1,
 * "Source or client-metadata SSRF": bounded reads). These fixtures are the
 * hostile or broken responses the client and bundle fetch must refuse.
 */

import { describe, expect, it } from 'vitest';
import { digestOfBytes, EXAMPLE_PROJECT_MD } from '@localfirst/contracts';
import { EXIT } from '../src/cli/errors.js';
import { RegistryClient, type RegistryTestDefinition } from '../src/cli/registry.js';
import { fetchRegistryBundle } from '../src/cli/registry-source.js';

const MiB = 1024 * 1024;

describe('registry response bounds', () => {
  it('refuses a body whose declared length exceeds the cap without reading it', async () => {
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(1024)); } });
    const fakeFetch = (async () => new Response(body, { status: 200, headers: { 'content-length': String(5 * MiB) } })) as typeof fetch;
    await expect(new RegistryClient('https://registry.example', fakeFetch).getDraft('d')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('stops an endless undeclared body at the cap and cancels it', async () => {
    let pulled = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { cancelled = true; },
    });
    const fakeFetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await expect(new RegistryClient('https://registry.example', fakeFetch).getDraft('d')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancelled).toBe(true);
    // 4 MiB in 64 KiB chunks, plus at most the read-ahead of the stream.
    expect(pulled).toBeLessThan(70);
  });

  it('counts bytes, not characters', async () => {
    // 1.5 million three-byte characters: under the cap in characters, over it in bytes.
    const text = JSON.stringify({ data: { note: '€'.repeat(1_500_000) } });
    const fakeFetch = (async () => new Response(text, { status: 200 })) as typeof fetch;
    await expect(new RegistryClient('https://registry.example', fakeFetch).getDraft('d')).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
  });

  it('still reads an ordinary response', async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ data: { draft_id: 'd' } }), { status: 200 })) as typeof fetch;
    await expect(new RegistryClient('https://registry.example', fakeFetch).getDraft('d')).resolves.toMatchObject({ draft_id: 'd' });
  });
});

describe('registry bundle refusals', () => {
  const file = (path: string, content: string, digest = digestOfBytes(content)) => ({ path, kind: 'test_manifest', content, content_digest: digest });
  const fetchWith = (overrides: Partial<RegistryTestDefinition>) => {
    const definition: RegistryTestDefinition = {
      test_definition_id: 'def', key: 'request-label-v1', project_id: 'p', project_version_id: 'v', runner_available: true,
      manifest_digest: 'x', fixture_digest: 'x', evaluator_digest: 'x', bundle_digest: 'x', bundle_files: [], ...overrides,
    };
    const client = {
      currentVersion: async () => ({ versionId: 'v', contentDigest: null }),
      exportProject: async () => ({ text: EXAMPLE_PROJECT_MD, etag: null }),
      projectTests: async () => [{ key: 'request-label-v1', test_definition_id: 'def' }],
      testDefinition: async () => definition,
    } as unknown as RegistryClient;
    return fetchRegistryBundle(client, { projectId: 'p', now: () => new Date() });
  };

  it('refuses more than 20 bundled files', async () => {
    const files = Array.from({ length: 21 }, (_, i) => file(`tests/t${i}.yaml`, 'key: x\n'));
    await expect(fetchWith({ bundle_files: files })).rejects.toMatchObject({ exitCode: EXIT.refused, message: expect.stringContaining('too many files') });
  });

  it('refuses a bundle larger than 2 MiB in total, even with matching digests', async () => {
    const big = 'a'.repeat(1.1 * MiB);
    await expect(fetchWith({ bundle_files: [file('tests/a.yaml', big), file('tests/b.yaml', big)] }))
      .rejects.toMatchObject({ exitCode: EXIT.refused, message: expect.stringContaining('2 MiB') });
  });

  it('refuses traversal, absolute, and backslash paths', async () => {
    for (const path of ['../escape.yaml', '/etc/passwd', 'tests\\win.yaml', 'tests/../../x.yaml']) {
      await expect(fetchWith({ bundle_files: [file(path, 'key: x\n')] }), path)
        .rejects.toMatchObject({ exitCode: EXIT.refused, message: expect.stringContaining('unsafe bundle path') });
    }
  });

  it('refuses a file whose content does not match its own digest', async () => {
    await expect(fetchWith({ bundle_files: [file('tests/a.yaml', 'key: x\n', digestOfBytes('something else'))] }))
      .rejects.toMatchObject({ exitCode: EXIT.refused, message: expect.stringContaining('does not match its digest') });
  });

  it('refuses a definition served for a different project version', async () => {
    await expect(fetchWith({ project_version_id: 'other' })).rejects.toMatchObject({ message: expect.stringContaining('different project version') });
  });
});
