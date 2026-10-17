/**
 * Bounded source ingestion checks (BACKEND_PRD sections 15.1, 15.3, 20.1).
 *
 * A fake provider is injected, so these tests exercise the adapter's own
 * limits, SSRF controls, and provenance rules without touching the network.
 */

import { describe, expect, it } from 'vitest';
import { bakeryBundle, bakeryFrameworkBundle, digestOfBytes, LANGGRAPH_LOCK_DIGEST, validateProjectBundle } from '@localfirst/contracts';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { drafts } from '../src/db/schema/registry.js';
import { importProjectFromGitHub } from '../src/sources/github.js';
import { SourceFetchError, assertAllowedSourceUrl, safeFetchText } from '../src/sources/safe-fetch.js';
import { runDraftImport } from '../src/services/import.js';
import { createImportProjectDraft } from '../src/services/drafts.js';
import { createAccount, projectDocument } from './factories.js';

const COMMIT = 'a'.repeat(40);

interface FakeOptions {
  repo?: Record<string, unknown>;
  manifest?: string;
  files?: Record<string, string>;
  status?: Record<string, number>;
  redirect?: boolean;
  oversize?: boolean;
  contentEntry?: Record<string, unknown>;
  commitEntry?: Record<string, unknown>;
}

function fakeGitHub(options: FakeOptions = {}): typeof fetch {
  const manifest = options.manifest ?? projectDocument({ key: 'imported-project' });
  return (async (input: URL | RequestInfo) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

    if (options.redirect) {
      throw Object.assign(new Error('unexpected redirect'), { name: 'TypeError' });
    }
    for (const [fragment, status] of Object.entries(options.status ?? {})) {
      if (url.includes(fragment)) return json({ message: 'error' }, status);
    }
    if (url.endsWith('/repos/acme/widget')) {
      return json({
        id: 12345,
        private: false,
        archived: false,
        default_branch: 'main',
        visibility: 'public',
        ...options.repo,
      });
    }
    if (url.includes('/commits/')) return json({ sha: COMMIT, ...options.commitEntry });
    if (url.includes('/contents/')) {
      const path = decodeURIComponent(url.split('/contents/')[1]?.split('?')[0] ?? '');
      const content = path === 'PROJECT.md' ? manifest : options.files?.[path];
      if (content === undefined) return json({ message: 'Not Found' }, 404);
      const buffer = Buffer.from(content, 'utf8');
      return json({
        type: 'file',
        path,
        size: options.oversize ? 10 * 1024 * 1024 : buffer.byteLength,
        encoding: 'base64',
        content: buffer.toString('base64'),
        ...options.contentEntry,
      });
    }
    return json({ message: 'Not Found' }, 404);
  }) as unknown as typeof fetch;
}

const descriptor = {
  provider: 'github' as const,
  repository_url: 'https://github.com/acme/widget',
  ref: 'main',
  manifest_path: 'PROJECT.md',
};

describe('safe fetch policy', () => {
  it('allows only https allowlisted hosts', async () => {
    await expect(assertAllowedSourceUrl('https://api.github.com/repos/a/b')).resolves.toBeInstanceOf(URL);
    await expect(assertAllowedSourceUrl('http://api.github.com/x')).rejects.toThrow(/https/);
    await expect(assertAllowedSourceUrl('https://evil.example.org/x')).rejects.toThrow(/allowlisted/);
    await expect(assertAllowedSourceUrl('https://user:pass@api.github.com/x')).rejects.toThrow(/credentials/);
    await expect(assertAllowedSourceUrl('https://127.0.0.1/x')).rejects.toThrow(/allowlisted/);
    await expect(assertAllowedSourceUrl('file:///etc/passwd')).rejects.toThrow();
  });

  it('caps the response size', async () => {
    const big = 'x'.repeat(4096);
    await expect(
      safeFetchText('https://api.github.com/anything', {
        maxBytes: 100,
        fetchImpl: (async () => new Response(big)) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/exceeds/);
  });

  it('classifies a timeout as unavailable rather than silently empty', async () => {
    await expect(
      safeFetchText('https://api.github.com/anything', {
        timeoutMs: 10,
        fetchImpl: (async (_input: unknown, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          })) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe('GitHub import adapter', () => {
  it('imports every declared environment asset at one commit, including an isolated creator module', async () => {
    const source = 'export function createWorkflow() { return { invoke: async () => ({}) }; }';
    for (const sample of [bakeryBundle(), bakeryFrameworkBundle({ profile: 'langgraph-docker/v0.1', sdk_version: '1.5.0', entry_digest: digestOfBytes(source), lock_digest: LANGGRAPH_LOCK_DIGEST }, source)]) {
      const requested: string[] = [];
      const provider = fakeGitHub({ manifest: sample.project_md, files: Object.fromEntries(sample.files.map(f => [f.path, f.content])) });
      const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => { requested.push(String(input)); return provider(input, init); }) as typeof fetch;
      const imported = await importProjectFromGitHub(descriptor, { fetchImpl });
      expect(imported.payload.files).toHaveLength(sample.files.length);
      expect(validateProjectBundle(imported.payload).ok).toBe(true);
      expect(requested.filter(url => url.includes('/commits/'))).toHaveLength(1);
      expect(requested.filter(url => url.includes('/contents/')).slice(1).every(url => url.endsWith('?ref=' + COMMIT))).toBe(true);
    }
  });
  it('resolves the ref once and pins repository sources to that commit', async () => {
    const manifest = projectDocument({
      key: 'pinned-import',
      sources: `  - key: repo
    kind: repository
    url: https://github.com/acme/widget
    revision: null
    content_digest: null
    license: {state: known, id: MIT, reference: "https://github.com/acme/widget/blob/main/LICENSE"}`,
    });
    const result = await importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ manifest }) });
    expect(result.repository.resolved_commit).toBe(COMMIT);
    expect(result.repository.provider_repo_id).toBe('12345');
    expect(result.payload.project_md).toContain(`revision: "${COMMIT}"`);
    const pinning = result.provenance.find(
      (entry) => entry.extraction_method === 'resolved_commit_pinning',
    );
    expect(pinning).toMatchObject({
      field_path: '/sources/repo/revision',
      source_version: COMMIT,
      evidence_class: 'documented',
    });
    expect(result.files_read).toEqual(['PROJECT.md']);
  });

  it('reads declared test files at the same commit', async () => {
    const manifest = projectDocument({
      key: 'with-tests',
      models:
        '{state: declared, roles: [{key: classifier, required_capabilities: [chat, json_output], minimum_context_tokens: 4096, substitution: allowed_for_task_test, preferred: null}]}',
      testSupport: 'declarative_task_v1',
    })
      .replace('tests: []', 'tests:\n  - key: smoke\n    schema: localfirst/test/v0.1\n    path: TESTS/smoke.yaml')
      .replace('    model_roles: []', '    model_roles: [classifier]');
    const result = await importProjectFromGitHub(descriptor, {
      fetchImpl: fakeGitHub({ manifest, files: { 'TESTS/smoke.yaml': 'schema: localfirst/test/v0.1\n' } }),
    });
    expect(result.files_read).toEqual(['PROJECT.md', 'TESTS/smoke.yaml']);
    expect(result.payload.files[0]?.path).toBe('TESTS/smoke.yaml');
  });

  it('refuses a private repository', async () => {
    await expect(
      importProjectFromGitHub(descriptor, {
        fetchImpl: fakeGitHub({ repo: { private: true, visibility: 'private' } }),
      }),
    ).rejects.toThrow(/public repositories/);
  });

  it('refuses a non-GitHub repository and an unsupported provider', async () => {
    await expect(
      importProjectFromGitHub(
        { ...descriptor, repository_url: 'https://gitlab.com/acme/widget' },
        { fetchImpl: fakeGitHub() },
      ),
    ).rejects.toThrow(/public github.com/);
    await expect(
      importProjectFromGitHub(
        { ...descriptor, provider: 'gitlab' as never },
        { fetchImpl: fakeGitHub() },
      ),
    ).rejects.toThrow(/not a supported import provider/);
  });

  it('refuses traversal and absolute manifest paths', async () => {
    for (const path of ['../../etc/passwd', '/etc/passwd', 'a/../../b']) {
      await expect(
        importProjectFromGitHub({ ...descriptor, manifest_path: path }, { fetchImpl: fakeGitHub() }),
      ).rejects.toThrow(/relative repository path/);
    }
  });

  it('refuses an oversize file and a secret-bearing manifest', async () => {
    await expect(
      importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ oversize: true }) }),
    ).rejects.toThrow(/per-file limit/);

    const withSecret = projectDocument({ key: 'leaky' }).replace(
      '## Purpose',
      '## Purpose\n\nAWS_SECRET=AKIAIOSFODNN7EXAMPLE',
    );
    await expect(
      importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ manifest: withSecret }) }),
    ).rejects.toThrow(/credential-like/);
  });

  it('classifies a missing manifest and a rate limit distinctly', async () => {
    await expect(
      importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ status: { contents: 404 } }) }),
    ).rejects.toThrow(/was not found/);
    await expect(
      importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ status: { commits: 429 } }) }),
    ).rejects.toThrow(/rate limited/);
  });

  it('refuses a ref with unsupported characters', async () => {
    await expect(
      importProjectFromGitHub({ ...descriptor, ref: 'main;rm -rf /' }, { fetchImpl: fakeGitHub() }),
    ).rejects.toThrow(/unsupported characters/);
  });

  it('rejects binary content', async () => {
    const binary = Buffer.from([0x00, 0x01, 0x02]).toString('utf8');
    await expect(
      importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ manifest: binary }) }),
    ).rejects.toThrow(/binary/);
  });
});

describe('import application', () => {
  it('applies an import result to the draft and records provenance', async () => {
    const account = await createAccount();
    const { draft } = await createImportProjectDraft({
      actor: account.actor,
      ownerUserId: account.userId,
      projectId: null,
      descriptor,
    });
    const outcome = await runDraftImport({
      draftId: draft.id,
      generation: 1,
      operationId: draft.operationId,
      fetchImpl: fakeGitHub(),
    });
    expect(outcome).toBe('applied');

    const [row] = await db().select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row?.state).toBe('ready_for_review');
    const descriptorRecord = row?.importDescriptor as Record<string, unknown>;
    expect((descriptorRecord.repository as Record<string, unknown>).resolved_commit).toBe(COMMIT);
    expect(Array.isArray(descriptorRecord.provenance)).toBe(true);
  });

  it('discards a stale import result instead of overwriting newer edits', async () => {
    const account = await createAccount();
    const { draft } = await createImportProjectDraft({
      actor: account.actor,
      ownerUserId: account.userId,
      projectId: null,
      descriptor,
    });
    // A newer attempt bumps the generation.
    await db().update(drafts).set({ sourceGeneration: 2 }).where(eq(drafts.id, draft.id));
    const outcome = await runDraftImport({
      draftId: draft.id,
      generation: 1,
      operationId: draft.operationId,
      fetchImpl: fakeGitHub(),
    });
    expect(outcome).toBe('stale');
  });

  it('records a failed import without losing the draft', async () => {
    const account = await createAccount();
    const { draft } = await createImportProjectDraft({
      actor: account.actor,
      ownerUserId: account.userId,
      projectId: null,
      descriptor,
    });
    await expect(
      runDraftImport({
        draftId: draft.id,
        generation: 1,
        operationId: draft.operationId,
        fetchImpl: fakeGitHub({ repo: { private: true } }),
      }),
    ).rejects.toThrow();
    const [row] = await db().select().from(drafts).where(eq(drafts.id, draft.id));
    expect(row?.state).toBe('ingestion_failed');
    expect((row?.importError as { code: string }).code).toBe('SOURCE_NOT_ALLOWED');
  });

  it('exposes SourceFetchError codes for the job layer to classify', () => {
    const error = new SourceFetchError('SOURCE_TOO_LARGE', 'too big');
    expect(error.code).toBe('SOURCE_TOO_LARGE');
    expect(error.name).toBe('SourceFetchError');
  });
});


describe('unusual provider responses', () => {
  it('rejects malformed repository and commit metadata safely', async () => {
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ repo: { id: null, private: null } }) })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ commitEntry: { sha: null } }) })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('rejects symlinks, invalid encodings and mismatched decoded sizes', async () => {
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ contentEntry: { type: 'symlink' } }) })).rejects.toMatchObject({ code: 'SOURCE_NOT_ALLOWED' });
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ contentEntry: { content: 'not base64' } }) })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ contentEntry: { size: 1 } }) })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
    await expect(importProjectFromGitHub(descriptor, { fetchImpl: fakeGitHub({ contentEntry: { path: 'other.md' } }) })).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  });
  it('stops reading a chunked body at the cap and cancels the upstream stream', async () => {
    let cancelled = false;
    const fetchImpl = (async () => new Response(new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(80)); },
      cancel() { cancelled = true; },
    }))) as typeof fetch;
    await expect(safeFetchText('https://api.github.com/test', { maxBytes: 100, fetchImpl })).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
    expect(cancelled).toBe(true);
  });
});
