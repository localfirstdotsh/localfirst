import { beforeAll, afterAll, afterEach, describe, it, expect } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { bakeryBundle, bakeryFrameworkBundle, stockReplenishmentBundle, LANGGRAPH_LOCK_DIGEST, digestOfBytes, digestOf, validateProjectBundle } from '@localfirst/contracts';
import { eq } from 'drizzle-orm';
import { config } from '../src/config.js';
import { db } from '../src/db/client.js';
import { projectVersions, projectVersionTests } from '../src/db/schema/registry.js';
import { testDefinitions } from '../src/db/schema/evidence.js';
import { getEnvironment, environmentPlanTemplate } from '../src/services/environments.js';
import { loadDefinitionByKey, serializeDefinitionDetail, runnerAvailabilityByVersion } from '../src/services/test-definitions.js';
import { createAccount, publishProject, request } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;
beforeAll(async () => { harness = await startTestServer(); });
afterAll(async () => { await harness.close(); });
afterEach(() => { config().features.agentEnvironments = false; config().features.workflowResults = false; config().features.frameworkEnvironments = false; });
async function world(sample = bakeryBundle()) {
  const owner = await createAccount();
  const published = await publishProject(owner, sample.project_md, sample.files);
  return { owner, sample, published };
}
async function rpc(method: string, params: unknown, token: string) {
  const response = await fetch(harness.baseUrl + '/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + token, 'mcp-protocol-version': '2025-06-18' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return response.json() as Promise<any>;
}
describe('immutable creator environments', () => {
  it('retrieves the ecommerce snapshot workflow and its missing live integration requirements over MCP', async () => {
    const { owner, sample, published } = await world(stockReplenishmentBundle());
    config().features.agentEnvironments = true;
    const token = await mintToken({ subject: owner.userId, audience: config().mcpResource, scopes: ['projects:read'] });
    const client = new Client({ name: 'stock-replenishment-client', version: '0.2.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(harness.baseUrl + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    try {
      const args = { project: published.projectId, version_id: published.projectVersionId, environment_key: sample.environment.key };
      const result = await client.callTool({ name: 'environment_get', arguments: args });
      const detail = result.structuredContent as Awaited<ReturnType<typeof getEnvironment>>;
      expect(detail.environment_digest).toBe(digestOf(sample.environment));
      expect(detail.environment.model_roles).toHaveLength(4);
      expect(detail.environment.nodes.find(n => n.kind === 'operation' && n.operation === 'replenishment_v1')).toBeDefined();
      const requirements = JSON.parse(detail.bundle_files.find(f => f.path === 'DATA/integration-requirements.json')!.content);
      expect(requirements.live_mode).toBe('requires_development');
      expect(requirements.connections).toContain('orders:read');
      expect(validateProjectBundle({ project_md: detail.project_md, files: detail.bundle_files }).content_digest).toBe(published.contentDigest);
      const handoff = await client.callTool({ name: 'environment_plan_local', arguments: { ...args, runtime_family: 'ollama' } });
      expect(handoff.structuredContent).toMatchObject({ executes: false, execution_authorization_required: true, effects: { network: 'loopback_only', trusted_operations: ['lookup_v1', 'replenishment_v1'] } });
      const definition = await loadDefinitionByKey(published.projectVersionId, sample.test.key);
      expect((await serializeDefinitionDetail(definition!)).schema).toBe('localfirst/test/v0.2');
    } finally { await client.close(); }
  });
  it('discovers, retrieves and hands off an environment through the official MCP client SDK', async () => {
    const { owner, sample, published } = await world();
    config().features.agentEnvironments = true;
    const token = await mintToken({ subject: owner.userId, audience: config().mcpResource, scopes: ['projects:read'] });
    const client = new Client({ name: 'localfirst-environment-client', version: '0.2.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(harness.baseUrl + '/mcp'), { requestInit: { headers: { authorization: 'Bearer ' + token } } }));
    try {
      const found = await client.callTool({ name: 'project_search', arguments: { q: 'bakery', test_support: ['declarative_workflow_v1'] } });
      expect((found.structuredContent as any).items.some((i: any) => i.project_id === published.projectId)).toBe(true);
      const args = { project: published.projectId, version_id: published.projectVersionId, environment_key: sample.environment.key };
      const environment = await client.callTool({ name: 'environment_get', arguments: args });
      expect((environment.structuredContent as any).environment_digest).toBe(digestOf(sample.environment));
      const plan = await client.callTool({ name: 'environment_plan_local', arguments: { ...args, runtime_family: 'ollama' } });
      expect((plan.structuredContent as any).executes).toBe(false);
      expect((plan.structuredContent as any).handoff.args).toEqual(['environment', 'prepare', published.projectId,
        '--version', published.projectVersionId, '--environment', sample.environment.key, '--registry', config().apiBaseUrl,
        '--out', './localfirst-' + sample.environment.key + '-' + published.projectVersionId]);
      const resource = await client.readResource({ uri: (environment.structuredContent as any).resource_uri });
      expect(JSON.parse((resource.contents[0] as any).text).bundle_digest).toBe(published.contentDigest);
    } finally { await client.close(); }
  });
  it('publishes and retrieves every digest-bound file with real workflow definitions', async () => {
    const { owner, sample, published } = await world();
    config().features.agentEnvironments = true;
    const detail = await getEnvironment(owner.actor, published.projectId, published.projectVersionId, sample.environment.key);
    expect(detail.environment_digest).toBe(digestOf(sample.environment));
    expect(detail.bundle_files).toHaveLength(sample.files.length);
    expect(validateProjectBundle({ project_md: detail.project_md, files: detail.bundle_files }).content_digest).toBe(published.contentDigest);
    const definition = await loadDefinitionByKey(published.projectVersionId, sample.test.key);
    expect(definition!.modelRole).toBeNull();
    expect((await serializeDefinitionDetail(definition!)).schema).toBe('localfirst/test/v0.2');
    const [version] = await db().select().from(projectVersions).where(eq(projectVersions.id, published.projectVersionId));
    expect(version!.schemaId).toBe('localfirst/project/v0.3');
    const [declaration] = await db().select().from(projectVersionTests).where(eq(projectVersionTests.projectVersionId, version!.id));
    expect(declaration!.environmentDigest).toBe(detail.environment_digest);
  });
  it('gates execution handoffs independently from readable historical documentation', async () => {
    const { owner, sample, published } = await world();
    await expect(getEnvironment(owner.actor, published.projectId, published.projectVersionId, sample.environment.key)).rejects.toMatchObject({ code: 'PHASE_UNAVAILABLE' });
    expect((await runnerAvailabilityByVersion([published.projectVersionId])).get(published.projectVersionId)).toBe(false);
    const token = await mintToken({ subject: owner.userId, audience: config().mcpResource, scopes: ['projects:read'] });
    const listed = await rpc('tools/list', {}, token);
    expect(listed.result.tools.some((t: any) => t.name === 'environment_get')).toBe(false);
    config().features.agentEnvironments = true;
    const tools = await rpc('tools/list', {}, token);
    expect(tools.result.tools.find((t: any) => t.name === 'environment_plan_local').annotations.readOnlyHint).toBe(true);
    expect(tools.result.tools.some((t: any) => /execute|test_run|environment_run/.test(t.name))).toBe(false);
  });
  it('hands off through a real authenticated MCP transport without probing or execution', async () => {
    const { owner, sample, published } = await world();
    config().features.agentEnvironments = true;
    const token = await mintToken({ subject: owner.userId, audience: config().mcpResource, scopes: ['projects:read'] });
    const result = await rpc('tools/call', { name: 'environment_plan_local', arguments: { project: published.projectId, version_id: published.projectVersionId, environment_key: sample.environment.key, runtime_family: 'ollama' } }, token);
    expect(result.result.isError).toBeFalsy();
    expect(result.result.structuredContent).toMatchObject({ executes: false, probing: 'none', upload_default: 'disabled' });
    expect(result.result.structuredContent.handoff.args).toContain(published.projectVersionId);
    const resource = await rpc('resources/read', { uri: 'localfirst://projects/' + published.projectId + '/versions/' + published.projectVersionId + '/environments/' + sample.environment.key }, token);
    expect(JSON.parse(resource.result.contents[0].text).environment_digest).toBe(digestOf(sample.environment));
    const detail = await getEnvironment(owner.actor, published.projectId, published.projectVersionId, sample.environment.key);
    expect(environmentPlanTemplate(detail, 'lmstudio').runtime_family).toBe('lmstudio');
  });
  it('enforces the database component/workflow role constraint', async () => {
    const { published } = await world();
    await expect(db().update(testDefinitions).set({ modelRole: 'fake-component-role' }).where(eq(testDefinitions.projectVersionId, published.projectVersionId))).rejects.toThrow();
  });
  it('discloses creator-code effects and gates the SDK profile separately', async () => {
    const owner = await createAccount(), source = 'export function createWorkflow() { return { invoke: async () => ({}) }; }';
    const sample = bakeryFrameworkBundle({ profile: 'langgraph-docker/v0.1', sdk_version: '1.5.0', entry_digest: digestOfBytes(source), lock_digest: LANGGRAPH_LOCK_DIGEST }, source);
    const published = await publishProject(owner, sample.project_md, sample.files);
    config().features.agentEnvironments = true;
    const detail = await getEnvironment(owner.actor, published.projectId, published.projectVersionId, sample.environment.key);
    expect(detail.runner_available).toBe(false);
    expect(environmentPlanTemplate(detail, 'ollama')).toMatchObject({ effects: { project_code: true }, framework_setup_authorization_required: true });
    config().features.frameworkEnvironments = true;
    expect((await getEnvironment(owner.actor, published.projectId, published.projectVersionId, sample.environment.key)).runner_available).toBe(true);
  });
  it('supports anonymous exact-version retrieval and refuses private or unrelated versions', async () => {
    const { sample, published } = await world();
    config().features.agentEnvironments = true;
    const path = '/api/v1/projects/' + published.projectId + '/versions/' + published.projectVersionId + '/environments/' + sample.environment.key;
    const response = await request(path);
    expect(response.status).toBe(200);
    const unknown = await request(path.replace(published.projectVersionId, '00000000-0000-4000-8000-000000000000'));
    expect(unknown.status).toBe(404);
  });
});
