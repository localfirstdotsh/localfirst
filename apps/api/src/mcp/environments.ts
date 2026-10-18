import { z } from 'zod';
import { ResourceTemplate, requireScopes, type McpServer } from '@modelcontextprotocol/server';
import type { Actor } from '../http/context.js';
import { hasScope } from '../http/context.js';
import { ApiError, isApiError } from '../http/errors.js';
import { getEnvironment, environmentPlanTemplate } from '../services/environments.js';
import { config } from '../config.js';

export function registerEnvironmentTools(server: McpServer, actor: Actor) {
  if (!config().features.agentEnvironments || !config().features.testDefinitions) return;
  const identifier = z.object({ project: z.string().min(1).max(100), version_id: z.uuid(), environment_key: z.string().max(64).regex(/^[a-z0-9-]+$/) }).strict();
  for (const name of ['environment_get', 'environment_plan_local'] as const) {
    server.registerTool(name, {
      title: name === 'environment_get' ? 'Read an agent environment' : 'Prepare a local environment handoff',
      description: 'Retrieve immutable public configuration. No local discovery, installation, inference, or execution authority.',
      inputSchema: name === 'environment_get' ? identifier : identifier.extend({ runtime_family: z.enum(['ollama', 'lmstudio']) }),
      annotations: { readOnlyHint: true, openWorldHint: false }, scopeChallenge: requireScopes('projects:read'),
    }, async args => {
      try {
        if (!hasScope(actor, 'projects:read')) throw ApiError.forbidden('projects:read is required.');
        const detail = await getEnvironment(actor, args.project, args.version_id, args.environment_key);
        const data = name === 'environment_get' ? detail : environmentPlanTemplate(detail, 'runtime_family' in args ? args.runtime_family as 'ollama' | 'lmstudio' : 'ollama');
        return { content: [{ type: 'text' as const, text: 'Environment retrieved. Execution must be approved locally.' }], structuredContent: data };
      } catch (cause) {
        const error = isApiError(cause) ? cause : ApiError.internal();
        return { isError: true, content: [{ type: 'text' as const, text: error.code + ': ' + error.message }], structuredContent: { error: { code: error.code, message: error.message } } };
      }
    });
  }
  server.registerResource('Agent environment', new ResourceTemplate('localfirst://projects/{project_id}/versions/{version_id}/environments/{environment_key}', { list: undefined }), {
    mimeType: 'application/json', scopeChallenge: requireScopes('projects:read'),
  }, async (uri, params) => {
    if (!hasScope(actor, 'projects:read')) throw ApiError.forbidden('projects:read is required.');
    const detail = await getEnvironment(actor, String(params.project_id), String(params.version_id), String(params.environment_key));
    return { contents: [{ uri: uri.toString(), mimeType: 'application/json', text: JSON.stringify(detail) }] };
  });
}
