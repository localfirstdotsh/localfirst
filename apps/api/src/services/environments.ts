import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { serializeProjectDocument, validateProjectBundle, digestOf, type AgentEnvironment } from '@localfirst/contracts';
import { db } from '../db/client.js';
import { projectVersionFiles } from '../db/schema/registry.js';
import { ApiError } from '../http/errors.js';
import type { Actor } from '../http/context.js';
import { config } from '../config.js';
import { loadVisibleProject, loadVersion } from './projects.js';

export async function getEnvironment(actor: Actor, projectRef: string, versionId: string, key: string) {
  if (!z.uuid().safeParse(versionId).success || !/^[a-z0-9-]{2,64}$/.test(key)) throw ApiError.badRequest('Invalid environment version or key.');
  if (!config().features.agentEnvironments || !config().features.testDefinitions) throw ApiError.phaseUnavailable('Agent environment handoffs');
  const project = await loadVisibleProject(z.uuid().safeParse(projectRef).success ? { id: projectRef } : { slug: projectRef }, actor);
  const version = await loadVersion(project.id, versionId);
  const files = await db().select().from(projectVersionFiles).where(eq(projectVersionFiles.projectVersionId, version.id));
  const projectMd = serializeProjectDocument(version.manifest, version.markdown);
  const bundle = validateProjectBundle({ project_md: projectMd, files: files.map(f => ({ path: f.path, content: f.content })) });
  if (!bundle.ok || bundle.content_digest !== version.contentDigest) throw ApiError.internal('The stored environment bundle failed integrity validation.');
  const env = bundle.environments?.find(e => e.manifest.key === key)?.manifest;
  if (!env) throw ApiError.notFound();
  return {
    project_id: project.id, project_version_id: version.id, environment_key: env.key,
    environment_digest: digestOf(env), bundle_digest: version.contentDigest, environment: env,
    runner_available: (bundle.workflow_tests ?? []).some(t => t.manifest.environment_key === env.key) && (!env.framework || config().features.frameworkEnvironments), minimum_runner_contract: env.runner_contract,
    project_md: projectMd,
    bundle_files: files.map(f => ({ path: f.path, content: f.content, content_digest: f.contentDigest })),
    resource_uri: `localfirst://projects/${project.id}/versions/${version.id}/environments/${env.key}`,
  };
}

export function environmentPlanTemplate(detail: Awaited<ReturnType<typeof getEnvironment>>, runtime: 'ollama' | 'lmstudio') {
  const env: AgentEnvironment = detail.environment;
  return {
    schema: 'localfirst/environment-plan-template/v0.1',
    project_id: detail.project_id, project_version_id: detail.project_version_id,
    environment_key: env.key, environment_digest: detail.environment_digest, bundle_digest: detail.bundle_digest,
    runtime_family: runtime, runner_available: detail.runner_available, model_roles: env.model_roles, limits: env.limits,
    effects: { downloads: false, project_code: env.execution.project_code, trusted_operations: env.nodes.filter(n => n.kind === 'operation').map(n => n.operation), network: 'loopback_only', writes_local_workspace: true },
    ...(env.framework ? { framework: env.framework, framework_setup_authorization_required: true } : {}),
    execution_authorization_required: true, execution_location: 'user_machine', upload_default: 'disabled', probing: 'none', executes: false,
    handoff: { executable: 'localfirstdotsh', args: ['environment', 'prepare', detail.project_id, '--version', detail.project_version_id, '--environment', env.key,
      '--registry', config().apiBaseUrl, '--out', './localfirst-' + env.key + '-' + detail.project_version_id] },
  };
}
