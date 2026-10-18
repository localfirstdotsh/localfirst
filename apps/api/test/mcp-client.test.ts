/**
 * A round trip with the official MCP client SDK (BACKEND_PRD section 13.1).
 *
 * This is the first entry in the tested client matrix: it proves the hosted
 * adapter negotiates, lists, calls, and reads with a real client
 * implementation rather than with hand-built JSON-RPC. It does not prove that
 * any particular end-user application works; those remain untested.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { config } from '../src/config.js';
import { createAccount, projectDocument, publishProject } from './factories.js';
import { mintToken, startTestServer, type Harness } from './server-harness.js';

let harness: Harness;

beforeAll(async () => {
  harness = await startTestServer();
});

afterAll(async () => {
  await harness.close();
});

async function connectClient(scopes: string[]): Promise<{ client: Client; close: () => Promise<void> }> {
  const account = await createAccount();
  const token = await mintToken({
    subject: account.userId,
    audience: config().mcpResource,
    scopes,
  });
  const client = new Client({ name: 'localfirst-matrix-probe', version: '0.2.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe('official MCP client round trip', () => {
  it('records the protocol versions this SDK release actually supports', () => {
    // The PRD treats the 2026-07-28 profile as a candidate. The pinned release
    // negotiates up to 2025-11-25, so that is what the matrix records.
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain('2025-11-25');
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
  });

  it('connects, negotiates, and reports server info', async () => {
    const { client, close } = await connectClient(['projects:read']);
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe('localfirst-registry');
      expect(client.getInstructions()).toMatch(/No tool here can reach your machine/);
    } finally {
      await close();
    }
  });

  it('lists exactly the implemented tools', async () => {
    const { client, close } = await connectClient(['projects:read', 'projects:draft', 'projects:publish']);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([
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
    } finally {
      await close();
    }
  });

  it('calls a tool and reads a resource through the client', async () => {
    const author = await createAccount();
    const published = await publishProject(author, projectDocument({ key: 'client-roundtrip' }));
    const { client, close } = await connectClient(['projects:read']);
    try {
      const searched = await client.callTool({ name: 'project_search', arguments: { q: 'registry' } });
      const structured = searched.structuredContent as { items: Array<{ slug: string }> };
      expect(structured.items.some((item) => item.slug === published.slug)).toBe(true);

      const templates = await client.listResourceTemplates();
      expect(
        templates.resourceTemplates.some((template) =>
          template.uriTemplate.endsWith('/manifest'),
        ),
      ).toBe(true);

      const read = await client.readResource({
        uri: `localfirst://projects/${published.projectId}/versions/${published.projectVersionId}/manifest`,
      });
      const contents = read.contents[0] as { text: string };
      expect(JSON.parse(contents.text).content_digest).toBe(published.contentDigest);
    } finally {
      await close();
    }
  });

  it('surfaces a domain blocker as a tool error, not a transport failure', async () => {
    const { client, close } = await connectClient(['projects:read']);
    try {
      const result = await client.callTool({
        name: 'project_get',
        arguments: { project: 'no-such-project' },
      });
      expect(result.isError).toBe(true);
      expect((result.structuredContent as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    } finally {
      await close();
    }
  });

  it('fails to connect without a token', async () => {
    const client = new Client({ name: 'localfirst-matrix-probe', version: '0.2.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`${harness.baseUrl}/mcp`));
    await expect(client.connect(transport)).rejects.toThrow();
  });
});
