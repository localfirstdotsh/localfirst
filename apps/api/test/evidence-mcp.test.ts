/**
 * Hosted MCP evidence tools (BACKEND_PRD sections 13.2, 13.3). The same rules
 * as the REST adapter: per-tool scopes, ownership, pending-never-verified, and
 * no tool that executes anything or reaches a machine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { createApproval, loadOwnedDraft } from '../src/services/drafts.js';
import { createAccount, request, type TestAccount } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';
import {
  acceptedRun,
  api,
  buildFor,
  failingResultFor,
  key,
  publishEvidenceProject,
  resultFor,
  submitThroughApi,
  type EvidenceProject,
} from './evidence-fixtures.js';

let harness: Harness;
beforeAll(async () => {
  harness = await startTestServer();
});
afterAll(async () => {
  await harness.close();
});

const PROTOCOL_VERSION = '2025-06-18';

async function rpc(method: string, params: unknown, token?: string): Promise<{ status: number; payload: any; challenge: string | null }> {
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': PROTOCOL_VERSION,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
    : text
      ? JSON.parse(text)
      : null;
  return { status: response.status, payload, challenge: response.headers.get('www-authenticate') };
}

const tokenFor = (account: TestAccount, scopes: string[]) =>
  mintToken({ subject: account.userId, audience: config().mcpResource, scopes });

async function call(token: string, name: string, args: Record<string, unknown>) {
  const response = await rpc('tools/call', { name, arguments: args }, token);
  // A scope challenge may come from the protocol layer (HTTP 403) or from the handler.
  if (response.status === 403) {
    return { isError: true, challenged: response.challenge, structuredContent: { error: { code: 'INSUFFICIENT_SCOPE' } } };
  }
  return response.payload.result ?? { isError: true, protocolError: response.payload.error };
}

const errorCode = (result: { structuredContent?: { error?: { code?: string } } }) => result.structuredContent?.error?.code;

async function world() {
  const project: EvidenceProject = await publishEvidenceProject(await createAccount());
  const contributor = await createAccount();
  return { project, contributor };
}

describe('tool inventory and annotations', () => {
  it('annotates tools honestly and offers no execution or discovery tool', async () => {
    const { contributor } = await world();
    const token = await tokenFor(contributor, ['projects:read']);
    const listed = await rpc('tools/list', {}, token);
    const tools = listed.payload.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>;
    const byName = new Map(tools.map((tool) => [tool.name, tool.annotations ?? {}]));
    for (const readOnly of ['test_get', 'test_plan_local', 'build_get', 'test_get_result', 'build_get_evidence']) {
      expect(byName.get(readOnly)?.readOnlyHint, readOnly).toBe(true);
    }
    for (const writes of ['build_save', 'test_submit_result', 'contribution_publish']) {
      expect(byName.get(writes)?.readOnlyHint, writes).toBe(false);
    }
    expect(tools.map((tool) => tool.name).some((name) => /run|execute|discover|probe/.test(name))).toBe(false);
  });
});

describe('test_get and test_plan_local', () => {
  it('reads a definition by ID or by project and key, and returns a generic plan', async () => {
    const { project, contributor } = await world();
    const token = await tokenFor(contributor, ['projects:read']);
    const byId = await call(token, 'test_get', { test_definition_id: project.definition.id });
    expect(byId.isError).toBeFalsy();
    expect(byId.structuredContent.manifest_digest).toBe(project.definition.manifestDigest);
    const byKey = await call(token, 'test_get', { project: project.published.slug, test_key: 'request-label-v1' });
    expect(byKey.structuredContent.test_definition_id).toBe(project.definition.id);

    const plan = await call(token, 'test_plan_local', { test_definition_id: project.definition.id, runtime_family: 'ollama' });
    expect(plan.structuredContent).toMatchObject({ probing: 'none', executes: false, target_runtime: 'ollama' });
    expect(plan.content[0].text).toContain('Nothing was probed or executed');
  });

  it('refuses a plan for a test the runner cannot execute, and needs projects:read', async () => {
    const author = await createAccount();
    const workflow = await publishEvidenceProject(author, (await import('@localfirst/contracts')).EXAMPLE_TEST_YAML.replace('scope: component', 'scope: workflow'));
    const token = await tokenFor(author, ['projects:read']);
    const blocked = await call(token, 'test_plan_local', { test_definition_id: workflow.definition.id });
    expect(blocked.isError).toBe(true);
    expect(errorCode(blocked)).toBe('PLAN_BLOCKED');

    const noScope = await tokenFor(author, ['profile:read']);
    const denied = await call(noScope, 'test_get', { test_definition_id: workflow.definition.id });
    expect(denied.isError).toBe(true);
  });
});

describe('build_save and build_get', () => {
  it('requires builds:write, is idempotent, and keeps the build private', async () => {
    const { project, contributor } = await world();
    const readOnly = await tokenFor(contributor, ['projects:read']);
    const denied = await call(readOnly, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-build-1' });
    expect(denied.isError).toBe(true);
    expect(errorCode(denied)).toBe('INSUFFICIENT_SCOPE');

    const token = await tokenFor(contributor, ['builds:write']);
    const saved = await call(token, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-build-1' });
    expect(saved.isError).toBeFalsy();
    expect(saved.structuredContent).toMatchObject({ visibility: 'private', reproducibility: 'complete', replayed: false });
    const again = await call(token, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-build-1' });
    expect(again.structuredContent.replayed).toBe(true);
    expect(again.structuredContent.build_id).toBe(saved.structuredContent.build_id);

    const forged = await call(token, 'build_save', { build: { ...buildFor(project), visibility: 'public' }, idempotency_key: 'mcp-build-2' });
    expect(forged.isError).toBe(true);
  });

  it('shows a private build to its owner only', async () => {
    const { project, contributor } = await world();
    const stranger = await createAccount();
    const owner = await tokenFor(contributor, ['builds:write']);
    const saved = await call(owner, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-build-own' });
    const id = saved.structuredContent.build_id;
    expect((await call(owner, 'build_get', { build_id: id })).isError).toBeFalsy();
    const other = await call(await tokenFor(stranger, ['projects:read', 'builds:write']), 'build_get', { build_id: id });
    expect(other.isError).toBe(true);
    expect(errorCode(other)).toBe('NOT_FOUND');
    // An owner holding only a read scope is asked for the right scope, not shown the build.
    const readOnly = await call(await tokenFor(contributor, ['projects:read']), 'build_get', { build_id: id });
    expect(readOnly.isError).toBe(true);
    expect(errorCode(readOnly)).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('test_submit_result and test_get_result', () => {
  it('stores a pending private report that no tool can mark verified', async () => {
    const { project, contributor } = await world();
    const token = await tokenFor(contributor, ['builds:write', 'tests:submit']);
    const saved = await call(token, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-b' });
    const buildId = saved.structuredContent.build_id;
    const submitted = await call(token, 'test_submit_result', {
      result: resultFor(project, buildId),
      build_id: buildId,
      idempotency_key: 'mcp-r-1',
    });
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent).toMatchObject({
      review_state: 'pending',
      evidence_level: null,
      visibility: 'private',
      validation_state: 'pending',
      replayed: false,
    });
    expect(submitted.structuredContent.operation_id).toBeTruthy();

    const sameBody = resultFor(project, buildId, { client_run_id: submitted.structuredContent.client_run_id });
    const replay = await call(token, 'test_submit_result', {
      result: sameBody,
      build_id: buildId,
      idempotency_key: 'mcp-r-1',
    });
    expect(replay.isError).toBeFalsy();
    expect(replay.structuredContent).toMatchObject({ replayed: true, report_id: submitted.structuredContent.report_id });
    // The same key with different content is a conflict, never a second report.
    const changed = await call(token, 'test_submit_result', {
      result: { ...sameBody, completed_at: '2026-10-12T00:00:00Z' },
      build_id: buildId,
      idempotency_key: 'mcp-r-1',
    });
    expect(changed.isError).toBe(true);
    expect(errorCode(changed)).toBe('IDEMPOTENCY_CONFLICT');

    for (const forged of [{ verified: true }, { evidence_level: 'independently_verified' }, { review_state: 'accepted' }, { badge: 'verified' }]) {
      const attempt = await call(token, 'test_submit_result', {
        result: { ...resultFor(project, buildId), ...forged },
        build_id: buildId,
        idempotency_key: key('forge'),
      });
      expect(attempt.isError, JSON.stringify(forged)).toBe(true);
    }
  });

  it('uses the build named by the result when no build is passed separately', async () => {
    const { project, contributor } = await world();
    const token = await tokenFor(contributor, ['builds:write', 'tests:submit']);
    const saved = await call(token, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-implicit-b' });
    const buildId = saved.structuredContent.build_id;
    const submitted = await call(token, 'test_submit_result', {
      result: resultFor(project, buildId),
      idempotency_key: 'mcp-implicit-r',
    });
    expect(submitted.isError).toBeFalsy();
    expect(submitted.structuredContent.build_id).toBe(buildId);
    const both = await call(token, 'test_submit_result', {
      result: resultFor(project, buildId),
      build_id: buildId,
      build: buildFor(project),
      idempotency_key: 'mcp-both',
    });
    expect(both.isError).toBe(true);
  });

  it('needs tests:submit, and builds:write as well to create the build inline', async () => {
    const { project, contributor } = await world();
    const submitOnly = await tokenFor(contributor, ['tests:submit']);
    const inline = await call(submitOnly, 'test_submit_result', {
      result: resultFor(project, 'placeholder'),
      build: buildFor(project),
      idempotency_key: key(),
    });
    expect(inline.isError).toBe(true);
    expect(errorCode(inline)).toBe('INSUFFICIENT_SCOPE');
    const buildOnly = await tokenFor(contributor, ['builds:write']);
    const none = await call(buildOnly, 'test_submit_result', {
      result: resultFor(project, 'placeholder'),
      build: buildFor(project),
      idempotency_key: key(),
    });
    expect(errorCode(none)).toBe('INSUFFICIENT_SCOPE');
    const both = await call(await tokenFor(contributor, ['tests:submit', 'builds:write']), 'test_submit_result', {
      result: resultFor(project, 'placeholder'),
      build: buildFor(project),
      idempotency_key: key(),
    });
    expect(both.isError).toBeFalsy();
  });

  it('shows a private result only to its submitter', async () => {
    const { project, contributor } = await world();
    const { reportId } = await submitThroughApi(contributor, project);
    const owner = await call(await tokenFor(contributor, ['tests:submit']), 'test_get_result', { result_id: reportId });
    expect(owner.isError).toBeFalsy();
    expect(owner.structuredContent.validation_state).toBe('valid');
    const stranger = await createAccount();
    const other = await call(await tokenFor(stranger, ['projects:read', 'tests:submit']), 'test_get_result', { result_id: reportId });
    expect(other.isError).toBe(true);
    expect(errorCode(other)).toBe('NOT_FOUND');
  });
});

describe('build_get_evidence', () => {
  it('lists accepted evidence with failures and contributors, narrowed by test or build', async () => {
    const { project } = await world();
    const operator = await createAccount({ operator: true });
    const first = await acceptedRun(project, operator);
    await acceptedRun(project, operator, { result: (id) => failingResultFor(project, id) });
    const token = await tokenFor(await createAccount(), ['projects:read']);

    const all = await call(token, 'build_get_evidence', { project: project.published.slug });
    expect(all.isError).toBeFalsy();
    expect(all.structuredContent.summaries).toHaveLength(1);
    expect(all.structuredContent.summaries[0]).toMatchObject({ conflict: true, distinct_contributors: 2, evidence_level: 'reproducible_test' });

    const byTest = await call(token, 'build_get_evidence', { project: project.published.slug, test_key: 'request-label-v1' });
    expect(byTest.structuredContent.summaries).toHaveLength(1);
    const wrongTest = await call(token, 'build_get_evidence', { project: project.published.slug, test_key: 'other-test' });
    expect(wrongTest.structuredContent.summaries).toHaveLength(0);
    const byBuild = await call(token, 'build_get_evidence', { project: project.published.slug, build_id: first.buildId });
    expect(byBuild.structuredContent.summaries).toHaveLength(1);
  });

  it('answers an owner asking about their own private build with no evidence instead of failing', async () => {
    const { project, contributor } = await world();
    const operator = await createAccount({ operator: true });
    await acceptedRun(project, operator);
    const writer = await tokenFor(contributor, ['builds:write', 'projects:read']);
    const saved = await call(writer, 'build_save', { build: buildFor(project), idempotency_key: 'private-evidence-build' });
    const evidence = await call(writer, 'build_get_evidence', { project: project.published.slug, build_id: saved.structuredContent.build_id });
    expect(evidence.isError, JSON.stringify(evidence)).toBeFalsy();
    expect(evidence.structuredContent.summaries).toEqual([]);
  });
});

describe('build and result contributions through the contribution tools', () => {
  it('creates, validates, and publishes a build draft only with the right scopes and a real approval', async () => {
    const { project, contributor } = await world();
    const writer = await tokenFor(contributor, ['builds:write']);
    const saved = await call(writer, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-pub-b' });
    const buildId = saved.structuredContent.build_id;

    const created = await call(writer, 'contribution_create_draft', {
      kind: 'build',
      record_id: buildId,
      selection: { hardware: 'coarse' },
      idempotency_key: 'mcp-pub-d',
    });
    expect(created.isError).toBeFalsy();
    const draft = created.structuredContent;
    expect(draft).toMatchObject({ kind: 'build', ready_for_review: true });

    // A project-draft token cannot create or read a build draft.
    const wrongScope = await call(await tokenFor(contributor, ['projects:draft']), 'draft_get', { draft_id: draft.draft_id });
    expect(wrongScope.isError).toBe(true);
    expect(errorCode(wrongScope)).toBe('INSUFFICIENT_SCOPE');

    // Editing the selection changes the exact artifact and revokes approval.
    const edited = await call(writer, 'draft_update', { draft_id: draft.draft_id, expected_revision: draft.revision, selection: { hardware: 'none' } });
    expect(edited.isError).toBeFalsy();
    expect(edited.structuredContent.payload_digest).not.toBe(draft.payload_digest);

    const validated = await call(writer, 'draft_validate', { draft_id: draft.draft_id });
    expect(validated.structuredContent.ready_for_review).toBe(true);
    expect(validated.structuredContent.projection.hardware).toBeNull();

    const forged = await call(await tokenFor(contributor, ['builds:publish']), 'contribution_publish', {
      draft_id: draft.draft_id,
      approval_id: '00000000-0000-4000-8000-000000000000',
      draft_revision: edited.structuredContent.revision,
      payload_digest: edited.structuredContent.payload_digest,
      idempotency_key: 'mcp-pub-forged',
    });
    expect(forged.isError).toBe(true);
    expect(errorCode(forged)).toBe('APPROVAL_REQUIRED');

    // Only a person in a browser session can approve the exact artifact.
    const current = await loadOwnedDraft(contributor.actor, draft.draft_id);
    const approval = await createApproval({
      actor: contributor.actor,
      draftId: current.id,
      draftRevision: current.revision,
      payloadDigest: current.payloadDigest,
      acknowledgedWarningCodes: current.warningCodes,
      decision: 'approved',
      sessionId: 'browser-session',
    });
    const args = {
      draft_id: draft.draft_id,
      approval_id: approval.approvalId,
      draft_revision: current.revision,
      payload_digest: current.payloadDigest,
      idempotency_key: 'mcp-pub-real',
    };
    const noPublishScope = await call(writer, 'contribution_publish', args);
    expect(noPublishScope.isError).toBe(true);
    expect(errorCode(noPublishScope)).toBe('INSUFFICIENT_SCOPE');

    const published = await call(await tokenFor(contributor, ['builds:publish']), 'contribution_publish', args);
    expect(published.isError).toBeFalsy();
    expect(published.structuredContent).toMatchObject({ visibility: 'public', review_state: 'pending', evidence_level: null });
    const publicView = await request(`/api/v1/builds/${buildId}`);
    expect(publicView.json.data.visibility).toBe('public');
  });
});

describe('evidence resources', () => {
  it('reads a definition, and a build only as its owner or when public', async () => {
    const { project, contributor } = await world();
    const owner = await tokenFor(contributor, ['builds:write', 'projects:read']);
    const saved = await call(owner, 'build_save', { build: buildFor(project), idempotency_key: 'mcp-res' });
    const buildId = saved.structuredContent.build_id;

    const definition = await rpc('resources/read', { uri: `localfirst://test-definitions/${project.definition.id}` }, owner);
    expect(JSON.parse(definition.payload.result.contents[0].text).manifest_digest).toBe(project.definition.manifestDigest);

    const own = await rpc('resources/read', { uri: `localfirst://builds/${buildId}` }, owner);
    expect(JSON.parse(own.payload.result.contents[0].text).build_id).toBe(buildId);

    const stranger = await tokenFor(await createAccount(), ['projects:read', 'builds:write']);
    const denied = await rpc('resources/read', { uri: `localfirst://builds/${buildId}` }, stranger);
    expect(denied.payload.error ?? denied.payload.result?.isError).toBeTruthy();
    void api;
  });
});

describe('community tools use the same services and consent boundary', () => {
  it('saves and drafts private community knowledge, refuses missing scopes, and reads eligible comparisons', async () => {
    const { project, contributor } = await world();
    const reader = await tokenFor(contributor, ['projects:read']);
    const writer = await tokenFor(contributor, ['projects:read', 'community:write']);
    const payload = { schema: 'localfirst/community/v0.1', title: 'Local text experiments', description: 'A curated collection for learning about local tests.', entries: [{ project_id: project.published.projectId, project_version_id: project.published.projectVersionId }], license: 'CC-BY-4.0' };
    const denied = await call(reader, 'community_save', { kind: 'collection', payload, idempotency_key: key() });
    expect(errorCode(denied)).toBe('INSUFFICIENT_SCOPE');
    const saved = await call(writer, 'community_save', { kind: 'collection', payload, idempotency_key: key() });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    const draft = await call(writer, 'contribution_create_draft', { kind: 'collection', record_id: saved.structuredContent.record_id, idempotency_key: key() });
    expect(draft.isError, JSON.stringify(draft)).not.toBe(true);
    const restOnlyCommunity = await api(contributor, '/api/v1/drafts', { method: 'POST', token: true, scopes: ['community:write'], body: { kind: 'collection', record_id: saved.structuredContent.record_id }, key: key() });
    expect(restOnlyCommunity.status, restOnlyCommunity.text).toBe(201);
    const publicList = await call(reader, 'community_list', { kind: 'collection' });
    expect(publicList.structuredContent.items).toEqual([]);
    const compared = await call(reader, 'comparison_get_groups', { project_version_id: project.published.projectVersionId });
    expect(compared.structuredContent.items).toEqual([]);
  });
});
