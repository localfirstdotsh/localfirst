/**
 * Hosted MCP adapter checks (BACKEND_PRD sections 13, 20.1).
 *
 * The same service behaviour must exist through MCP and REST, the tool
 * inventory must contain no future-phase or execution tool, and the token
 * audience must be the MCP resource.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MCP_TOOL_CATALOG } from '@localfirst/contracts';
import { config } from '../src/config.js';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { hardwareDescriptors, modelReferences, projects } from '../src/db/schema/registry.js';
import { createAccount, projectDocument, publishProject } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startTestServer();
});

afterAll(async () => {
  await harness.close();
});

const PROTOCOL_VERSION = '2025-06-18';

interface RpcOptions {
  token?: string;
  protocolVersion?: string;
}

async function rpc(method: string, params: unknown, options: RpcOptions = {}): Promise<any> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  if (options.protocolVersion !== null) {
    headers['mcp-protocol-version'] = options.protocolVersion ?? PROTOCOL_VERSION;
  }
  const response = await fetch(`${harness.baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  // The stateless transport may answer as JSON or as a single SSE event.
  const payload = text.startsWith('event:') || text.startsWith('data:')
    ? JSON.parse(
        text
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join(''),
      )
    : text
      ? JSON.parse(text)
      : null;
  return { status: response.status, headers: response.headers, payload };
}

async function session(scopes: string[]): Promise<{ token: string; userId: string; handle: string }> {
  const account = await createAccount();
  const token = await mintToken({
    subject: account.userId,
    audience: config().mcpResource,
    scopes,
  });
  return { token, userId: account.userId, handle: account.handle };
}

describe('MCP transport', () => {
  it('challenges an unauthenticated request with RFC 9728 metadata', async () => {
    const response = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('resource_metadata=');
    expect(challenge).toContain('oauth-protected-resource');
  });

  it('refuses a REST-audience token at the MCP resource', async () => {
    const account = await createAccount();
    const restToken = await mintToken({
      subject: account.userId,
      audience: config().restResource,
      scopes: ['projects:read'],
    });
    const response = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }, { token: restToken });
    expect(response.status).toBe(401);
  });

  it('answers 405 for GET and DELETE in the stateless profile', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${harness.baseUrl}/mcp`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toContain('POST');
    }
  });

  it('allows an explicit preflight without executing anything', async () => {
    const response = await fetch(`${harness.baseUrl}/mcp`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('allow')).toBe('POST, OPTIONS');
  });

  it('initializes and advertises the implemented tool inventory only', async () => {
    const { token } = await session(['projects:read', 'projects:draft', 'projects:publish']);
    const initialized = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'test-client', version: '1.0.0' },
    }, { token });
    expect(initialized.status).toBe(200);
    expect(initialized.payload.result.serverInfo.name).toBe('localfirst-registry');
    expect(initialized.payload.result.instructions).toContain(
      'No tool here can reach your machine',
    );

    const tools = await rpc('tools/list', {}, { token });
    const names = (tools.payload.result.tools as Array<{ name: string }>).map((tool) => tool.name).sort();
    expect(names).toEqual([
      'build_get',
      'build_get_evidence',
      'build_save',
      'community_list',
      'community_save',
      'comparison_get_groups',
      'contribution_create_draft',
      'contribution_publish',
      'draft_get',
      'draft_update',
      'draft_validate',
      'project_check_compatibility',
      'project_create_derivative_draft',
      'project_get',
      'project_get_derivatives',
      'project_search',
      'reference_get_relationships',
      'test_get',
      'test_get_result',
      'test_get_verifications',
      'test_plan_local',
      'test_submit_result',
    ]);
    // No future-phase, discovery, or execution tool is discoverable.
    for (const forbidden of [
      'local_runtime_discover',
      'runtime_discover',
      'test_run',
      'test_execute',
      'run_test',
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it('matches the public tool catalog the connect page shows', async () => {
    const { token } = await session(['projects:read', 'projects:draft', 'projects:publish']);
    const tools = await rpc('tools/list', {}, { token });
    const advertised = new Map(
      (tools.payload.result.tools as Array<{ name: string; title?: string; annotations?: { readOnlyHint?: boolean } }>).map(
        (tool) => [tool.name, tool],
      ),
    );
    expect([...advertised.keys()].sort()).toEqual(MCP_TOOL_CATALOG.map((entry) => entry.name).sort());
    for (const entry of MCP_TOOL_CATALOG) {
      const tool = advertised.get(entry.name)!;
      expect(tool.title, entry.name).toBe(entry.title);
      expect(tool.annotations?.readOnlyHint, entry.name).toBe(entry.access === 'read');
    }
  });

  it('annotates read-only tools honestly', async () => {
    const { token } = await session(['projects:read', 'projects:draft']);
    const tools = await rpc('tools/list', {}, { token });
    const byName = new Map(
      (tools.payload.result.tools as Array<{ name: string; annotations?: Record<string, unknown> }>).map(
        (tool) => [tool.name, tool.annotations ?? {}],
      ),
    );
    expect(byName.get('project_search')?.readOnlyHint).toBe(true);
    expect(byName.get('project_get')?.readOnlyHint).toBe(true);
    expect(byName.get('project_check_compatibility')?.readOnlyHint).toBe(true);
    // Validation updates derived state, so it is not read-only.
    expect(byName.get('draft_validate')?.readOnlyHint).toBe(false);
    expect(byName.get('contribution_publish')?.readOnlyHint).toBe(false);
  });

  it('searches and reads projects with the same facts the REST adapter returns', async () => {
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'mcp-parity' }));
    const { token } = await session(['projects:read']);

    const searched = await rpc('tools/call', {
      name: 'project_search',
      arguments: { q: 'registry' },
    }, { token });
    const structured = searched.payload.result.structuredContent;
    expect(structured.items.some((item: { slug: string }) => item.slug === published.slug)).toBe(true);

    const fetched = await rpc('tools/call', {
      name: 'project_get',
      arguments: { project: published.slug },
    }, { token });
    const detail = fetched.payload.result.structuredContent;
    expect(detail.version.content_digest).toBe(published.contentDigest);
    expect(detail.version.tests).toEqual([]);

    const rest = await fetch(`${harness.baseUrl}/api/v1/projects/${published.projectId}`);
    const restJson = await rest.json();
    expect(restJson.data.current_version.content_digest).toBe(detail.version.content_digest);
  });

  it('returns a compatibility assessment without probing anything', async () => {
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'mcp-compat' }));
    const { token } = await session(['projects:read']);
    const assessed = await rpc('tools/call', {
      name: 'project_check_compatibility',
      arguments: {
        project: published.projectId,
        request: { requirements: { inference: 'local_required', offline: true } },
      },
    }, { token });
    const assessment = assessed.payload.result.structuredContent;
    expect(assessment.outcome).toBe('unknown');
    expect(assessment.test_support).toEqual({ declared_kind: 'none', runner_available: false });
    expect(assessment.evidence_scope).toBe('requirements_only');
  });

  it('denies a tool call that lacks its scope with a stable code', async () => {
    const { token } = await session(['projects:read']);
    const denied = await rpc('tools/call', {
      name: 'contribution_create_draft',
      arguments: {
        kind: 'project',
        project_md: projectDocument({ key: 'mcp-scope' }),
        idempotency_key: 'mcp-scope-1',
      },
    }, { token });
    // Either the protocol-level scope challenge or the handler's own check
    // refuses it; both are safe and name the missing scope.
    if (denied.status === 403) {
      expect(denied.headers.get('www-authenticate')).toContain('insufficient_scope');
    } else {
      expect(denied.payload.result.isError).toBe(true);
      expect(denied.payload.result.structuredContent.error.code).toBe('INSUFFICIENT_SCOPE');
    }
  });

  it('creates, validates, and publishes through MCP with a human approval in between', async () => {
    const account = await createAccount();
    const token = await mintToken({
      subject: account.userId,
      audience: config().mcpResource,
      scopes: ['projects:read', 'projects:draft', 'projects:publish'],
    });

    const created = await rpc('tools/call', {
      name: 'contribution_create_draft',
      arguments: {
        kind: 'project',
        project_md: projectDocument({ key: 'mcp-publish' }),
        idempotency_key: 'mcp-publish-1',
      },
    }, { token });
    const draft = created.payload.result.structuredContent;
    expect(draft.state).toBe('ready_for_review');
    expect(draft.review_url).toContain('/review/drafts/');

    const validated = await rpc('tools/call', {
      name: 'draft_validate',
      arguments: { draft_id: draft.draft_id },
    }, { token });
    expect(validated.payload.result.structuredContent.ready_for_review).toBe(true);

    // An agent cannot mint the approval: a person does it in a browser session.
    const approval = await fetch(`${harness.baseUrl}/api/v1/drafts/${draft.draft_id}/approval`, {
      method: 'POST',
      headers: { 'x-dev-user': account.userId, 'content-type': 'application/json' },
      body: JSON.stringify({
        draft_revision: draft.revision,
        payload_digest: draft.payload_digest,
        acknowledged_warning_codes: draft.warning_codes,
      }),
    });
    const approvalJson = await approval.json();

    const published = await rpc('tools/call', {
      name: 'contribution_publish',
      arguments: {
        draft_id: draft.draft_id,
        approval_id: approvalJson.data.approval_id,
        draft_revision: draft.revision,
        payload_digest: draft.payload_digest,
        idempotency_key: 'mcp-publish-final',
      },
    }, { token });
    const result = published.payload.result.structuredContent;
    expect(result.visibility).toBe('published');
    expect(result.evidence_level).toBe('claimed');
    expect(published.payload.result.content[0].text).toContain('records no test evidence');
  });

  it('refuses to publish with a forged approval claim', async () => {
    const account = await createAccount();
    const token = await mintToken({
      subject: account.userId,
      audience: config().mcpResource,
      scopes: ['projects:draft', 'projects:publish'],
    });
    const created = await rpc('tools/call', {
      name: 'contribution_create_draft',
      arguments: {
        kind: 'project',
        project_md: projectDocument({ key: 'mcp-forged' }),
        idempotency_key: 'mcp-forged-1',
      },
    }, { token });
    const draft = created.payload.result.structuredContent;

    const published = await rpc('tools/call', {
      name: 'contribution_publish',
      arguments: {
        draft_id: draft.draft_id,
        approval_id: '00000000-0000-4000-8000-000000000000',
        draft_revision: draft.revision,
        payload_digest: draft.payload_digest,
        idempotency_key: 'mcp-forged-publish',
      },
    }, { token });
    expect(published.payload.result.isError).toBe(true);
    expect(published.payload.result.structuredContent.error.code).toBe('APPROVAL_REQUIRED');
  });

  it('serves owned resources and refuses other accounts’ drafts', async () => {
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'mcp-resource' }));
    const { token } = await session(['projects:read']);

    const listed = await rpc('resources/templates/list', {}, { token });
    const templates = (listed.payload.result.resourceTemplates as Array<{ uriTemplate: string }>).map(
      (template) => template.uriTemplate,
    );
    expect(templates).toContain('localfirst://projects/{project_id}/versions/{version_id}/manifest');
    expect(templates).toEqual(
      expect.arrayContaining([
        'localfirst://test-definitions/{test_definition_id}',
        'localfirst://builds/{build_id}',
        'localfirst://test-results/{result_id}',
      ]),
    );
    // No resource exposes execution or a local runtime.
    expect(templates.some((template) => /runtime|execute|run\b/.test(template))).toBe(false);

    const read = await rpc('resources/read', {
      uri: `localfirst://projects/${published.projectId}/versions/${published.projectVersionId}/manifest`,
    }, { token });
    const contents = read.payload.result.contents[0];
    expect(contents.mimeType).toBe('application/json');
    expect(JSON.parse(contents.text).content_digest).toBe(published.contentDigest);

    // A draft belonging to someone else is not readable by ID.
    const otherDraft = await fetch(`${harness.baseUrl}/api/v1/drafts`, {
      method: 'POST',
      headers: {
        'x-dev-user': author.userId,
        'content-type': 'application/json',
        'idempotency-key': 'mcp-other-draft',
      },
      body: JSON.stringify({ kind: 'project', project_md: projectDocument({ key: 'mcp-private' }) }),
    });
    const otherDraftJson = await otherDraft.json();
    const denied = await rpc('resources/read', {
      uri: `localfirst://drafts/${otherDraftJson.data.draft_id}`,
    }, { token });
    expect(denied.payload.error ?? denied.payload.result?.isError).toBeTruthy();
  });

  it('serves model and hardware references with only visible declaring projects', async () => {
    const author = await createAccount();
    const declares = (key: string) => projectDocument({
      key,
      models: '{state: declared, roles: [{key: chat, required_capabilities: [chat], substitution: allowed_for_task_test, preferred: "resource-test-model:1b"}]}',
      hardware: '{state: declared, architectures: [arm64], minimum_memory_bytes: null, accelerator: optional, devices: ["Resource Test Board"]}',
    });
    const visible = await publishProject(author, declares('mcp-reference-visible'));
    const hidden = await publishProject(author, declares('mcp-reference-hidden'));
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, hidden.projectId));
    const { token } = await session(['projects:read']);

    const listed = await rpc('resources/templates/list', {}, { token });
    const templates = (listed.payload.result.resourceTemplates as Array<{ uriTemplate: string }>).map((template) => template.uriTemplate);
    expect(templates).toEqual(expect.arrayContaining(['localfirst://models/{model_reference_id}', 'localfirst://hardware/{hardware_descriptor_id}']));

    const [model] = await db().select({ id: modelReferences.id }).from(modelReferences).where(eq(modelReferences.key, 'resource-test-model-1b'));
    const [board] = await db().select({ id: hardwareDescriptors.id }).from(hardwareDescriptors).where(eq(hardwareDescriptors.key, 'resource-test-board'));
    for (const [uri, idField] of [[`localfirst://models/${model!.id}`, 'model_reference_id'], [`localfirst://hardware/${board!.id}`, 'hardware_descriptor_id']] as const) {
      const read = await rpc('resources/read', { uri }, { token });
      const contents = read.payload.result.contents[0];
      expect(contents.mimeType).toBe('application/json');
      const view = JSON.parse(contents.text);
      expect(view[idField]).toBe(uri.split('/').pop());
      expect(view.declared_by.items.map((item: { project_id: string }) => item.project_id)).toEqual([visible.projectId]);
      expect(contents.text).not.toContain(hidden.projectId);
    }

    // With its only declaring project hidden, a reference is not disclosed by ID.
    await db().update(projects).set({ visibility: 'quarantined', quarantinedAt: new Date() }).where(eq(projects.id, visible.projectId));
    const gone = await rpc('resources/read', { uri: `localfirst://models/${model!.id}` }, { token });
    expect(gone.payload.error ?? gone.payload.result?.isError).toBeTruthy();
    for (const uri of ['localfirst://models/00000000-0000-0000-0000-000000000000', 'localfirst://hardware/not-a-uuid']) {
      const read = await rpc('resources/read', { uri }, { token });
      expect(read.payload.error ?? read.payload.result?.isError, uri).toBeTruthy();
    }
  });

  it('refuses unknown evidence resources and unimplemented families', async () => {
    const { token } = await session(['projects:read']);
    for (const uri of [
      'localfirst://test-results/00000000-0000-0000-0000-000000000000',
      'localfirst://builds/does-not-exist',
      'localfirst://test-definitions/00000000-0000-0000-0000-000000000000',
      'localfirst://tests/anything',
    ]) {
      const read = await rpc('resources/read', { uri }, { token });
      expect(read.payload.error ?? read.payload.result?.isError, uri).toBeTruthy();
    }
  });
});
