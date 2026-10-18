/**
 * Deterministic domain rules (BACKEND_PRD sections 9, 10.4, 20.4).
 *
 * These are unit fixtures: no storage or protocol boundary is involved.
 */

import { describe, expect, it } from 'vitest';
import {
  compatibilityRequestSchema,
  validateProjectBundle,
  type ProjectSpec,
} from '@localfirst/contracts';
import { assessCompatibility } from '../src/domain/compatibility.js';
import {
  assertApprovalUsable,
  assertWarningsAcknowledged,
  unacknowledgedWarnings,
  type ApprovalRecordLike,
} from '../src/domain/approval.js';
import { APPROVAL_POLICY_VERSION } from '../src/domain/policy.js';
import { isReservedSlug, slugCandidates, slugify } from '../src/domain/slug.js';
import { loadConfig, ConfigError } from '../src/config.js';
import { projectDocument } from './factories.js';

function specFor(document: string): ProjectSpec {
  const result = validateProjectBundle({ project_md: document });
  if (!result.spec) throw new Error(`fixture invalid: ${JSON.stringify(result.issues)}`);
  return result.spec;
}

const DECLARED = projectDocument({
  key: 'compat-fixture',
  runtimes: '{state: declared, supported: [{family: ollama, version_constraint: ">=0.1"}]}',
  hardware:
    '{state: declared, architectures: [arm64], minimum_memory_bytes: 8589934592, minimum_vram_bytes: null, accelerator: optional, devices: []}',
  models:
    '{state: declared, roles: [{key: classifier, required_capabilities: [chat, json_output], minimum_context_tokens: 4096, substitution: allowed_for_task_test, preferred: null}]}',
  dataBoundary: '{inference: local_required, storage: local, runtime_network: unknown, external_services: []}',
}).replace('    model_roles: []', '    model_roles: [classifier]');

function assess(request: unknown, document = DECLARED) {
  return assessCompatibility({
    projectId: 'project-1',
    projectVersionId: 'version-1',
    spec: specFor(document),
    sourcesPinned: false,
    request: compatibilityRequestSchema.parse(request),
    runnerAvailable: false,
  });
}

describe('compatibility assessment', () => {
  it('returns unknown when nothing about the environment was shared', () => {
    const result = assess({});
    expect(result.outcome).toBe('unknown');
    expect(result.uncertainties[0]).toMatch(/No environment was shared/);
    expect(result.evidence_scope).toBe('requirements_only');
    expect(result.evidence_ids).toEqual([]);
  });

  it('returns candidate when every known requirement passes', () => {
    const result = assess({
      configuration_key: 'reading-only',
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      runtime: { family: 'ollama', version: '0.2.0' },
      selected_models: [
        {
          role: 'classifier',
          capabilities: ['chat', 'json_output'],
          context_tokens: 8192,
          execution_location: 'local',
          identity_known: true,
        },
      ],
    });
    expect(result.outcome).toBe('candidate');
    expect(result.blockers).toEqual([]);
    expect(result.uncertainties.join(' ')).toMatch(/`candidate` is not a guarantee/);
  });

  it('is incompatible when a hard requirement fails', () => {
    const architecture = assess({
      hardware: { cpu_architecture: 'x86_64', memory_bytes: 17179869184 },
      runtime: { family: 'ollama' },
    });
    expect(architecture.outcome).toBe('incompatible');
    expect(architecture.blockers.join(' ')).toMatch(/architectures/);

    const memory = assess({
      hardware: { cpu_architecture: 'arm64', memory_bytes: 4294967296 },
      runtime: { family: 'ollama' },
    });
    expect(memory.outcome).toBe('incompatible');

    const runtime = assess({
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      runtime: { family: 'vllm' },
    });
    expect(runtime.outcome).toBe('incompatible');

    const capability = assess({
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      runtime: { family: 'ollama' },
      selected_models: [
        {
          role: 'classifier',
          capabilities: ['chat'],
          unsupported_capabilities: ['json_output'],
          context_tokens: 8192,
          execution_location: 'local',
        },
      ],
    });
    expect(capability.outcome).toBe('incompatible');
    expect(capability.blockers.join(' ')).toMatch(/json_output/);
  });

  it('is unknown when a critical fact is missing', () => {
    const result = assess({
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      // No runtime shared, but the project declares one.
      selected_models: [
        {
          role: 'classifier',
          capabilities: ['chat', 'json_output'],
          context_tokens: 8192,
          execution_location: 'local',
        },
      ],
    });
    expect(result.outcome).toBe('unknown');
  });

  it('blocks a requested local-only plan when locality is unresolved', () => {
    const result = assess({
      requirements: { inference: 'local_required', offline: false, accelerator: null },
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      runtime: { family: 'ollama' },
      selected_models: [
        {
          role: 'classifier',
          capabilities: ['chat', 'json_output'],
          context_tokens: 8192,
          execution_location: 'unknown',
        },
      ],
    });
    expect(result.outcome).toBe('unknown');
    const locality = result.checks.find((check) => check.requirement === 'local_inference');
    expect(locality?.status).toBe('unknown');
    expect(locality?.detail).toMatch(/assertion is not a locality check/);
  });

  it('never reports offline as observed', () => {
    const offlineCapable = DECLARED.replace(
      '{inference: local_required, storage: local, runtime_network: unknown, external_services: []}',
      '{inference: local_required, storage: local, runtime_network: none, external_services: []}',
    );
    const result = assess(
      {
        requirements: { inference: 'local_required', offline: true, accelerator: null },
        hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
        runtime: { family: 'ollama' },
        selected_models: [
          {
            role: 'classifier',
            capabilities: ['chat', 'json_output'],
            context_tokens: 8192,
            execution_location: 'local',
          },
        ],
      },
      offlineCapable,
    );
    expect(result.outcome).toBe('unknown');
    expect(result.checks.find((check) => check.requirement === 'offline')?.status).toBe('unknown');
    expect(result.uncertainties.join(' ')).toMatch(/documented egress restriction/);
  });

  it('never counts unified memory as separate accelerator memory', () => {
    const withVram = DECLARED.replace('minimum_vram_bytes: null', 'minimum_vram_bytes: 8589934592');
    const result = assess(
      {
        hardware: {
          cpu_architecture: 'arm64',
          memory_bytes: 17179869184,
          unified_memory: true,
          vram_bytes: null,
        },
        runtime: { family: 'ollama' },
        selected_models: [
          {
            role: 'classifier',
            capabilities: ['chat', 'json_output'],
            context_tokens: 8192,
            execution_location: 'local',
          },
        ],
      },
      withVram,
    );
    const vram = result.checks.find((check) => check.requirement === 'declared_minimum_vram');
    expect(vram?.status).toBe('unknown');
    expect(vram?.detail).toMatch(/unified memory/);
  });

  it('separates installable prerequisites from incompatibility', () => {
    const withDependencies = DECLARED.replace(
      'dependencies: {state: unknown, items: []}',
      'dependencies: {state: declared, items: [{name: ffmpeg, kind: system, version_constraint: ">=6", license: null}]}',
    );
    const result = assess(
      {
        hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
        runtime: { family: 'ollama' },
        selected_models: [
          {
            role: 'classifier',
            capabilities: ['chat', 'json_output'],
            context_tokens: 8192,
            execution_location: 'local',
          },
        ],
      },
      withDependencies,
    );
    expect(result.missing_prerequisites).toEqual(['ffmpeg >=6 (system)']);
    expect(result.blockers).toEqual([]);
  });

  it('reports an unknown configuration honestly', () => {
    const result = assess({ configuration_key: 'does-not-exist' });
    expect(result.outcome).toBe('unknown');
    expect(result.uncertainties.join(' ')).toMatch(/not declared/);
  });

  it('never reaches evidence_match in Phase 1', () => {
    const result = assess({
      hardware: { cpu_architecture: 'arm64', memory_bytes: 17179869184 },
      runtime: { family: 'ollama' },
      selected_models: [
        {
          role: 'classifier',
          capabilities: ['chat', 'json_output'],
          context_tokens: 8192,
          execution_location: 'local',
          identity_known: true,
        },
      ],
    });
    expect(result.outcome).not.toBe('evidence_match');
    expect(['claimed', 'documented']).toContain(result.evidence_level);
    expect(result.test_support.runner_available).toBe(false);
  });
});

describe('approval rules', () => {
  const base: ApprovalRecordLike = {
    id: 'approval-1',
    draftId: 'draft-1',
    kind: 'project',
    actorUserId: 'user-1',
    draftRevision: 3,
    payloadDigest: `sha256:${'a'.repeat(64)}`,
    acknowledgedWarningCodes: ['WARN_ONE'],
    policyVersion: APPROVAL_POLICY_VERSION,
    decision: 'approved',
    expiresAt: new Date(Date.now() + 60_000),
    consumedAt: null,
    revokedAt: null,
  };
  const target = {
    draftId: 'draft-1',
    kind: 'project',
    revision: 3,
    payloadDigest: base.payloadDigest,
    warningCodes: ['WARN_ONE'],
  };
  const claim = {
    approvalId: 'approval-1',
    draftRevision: 3,
    payloadDigest: base.payloadDigest,
  };

  it('accepts a matching, live, single-use approval', () => {
    expect(() => assertApprovalUsable(base, target, claim, 'user-1')).not.toThrow();
  });

  it('rejects a missing, expired, consumed, or revoked approval', () => {
    expect(() => assertApprovalUsable(undefined, target, claim, 'user-1')).toThrow(/required/i);
    expect(() =>
      assertApprovalUsable({ ...base, expiresAt: new Date(Date.now() - 1000) }, target, claim, 'user-1'),
    ).toThrow(/expired/i);
    expect(() =>
      assertApprovalUsable({ ...base, consumedAt: new Date() }, target, claim, 'user-1'),
    ).toThrow(/already used/i);
    expect(() =>
      assertApprovalUsable({ ...base, revokedAt: new Date() }, target, claim, 'user-1'),
    ).toThrow(/revoked/i);
  });

  it('rejects a changed revision or digest', () => {
    expect(() =>
      assertApprovalUsable(base, { ...target, revision: 4 }, claim, 'user-1'),
    ).toThrow(/changed after it was approved/i);
    expect(() =>
      assertApprovalUsable(
        base,
        { ...target, payloadDigest: `sha256:${'b'.repeat(64)}` },
        claim,
        'user-1',
      ),
    ).toThrow(/changed after it was approved/i);
  });

  it('rejects another actor, another kind, a denial, and a superseded policy', () => {
    expect(() => assertApprovalUsable(base, target, claim, 'user-2')).toThrow(/approving account/i);
    expect(() => assertApprovalUsable({ ...base, kind: 'build' }, target, claim, 'user-1')).toThrow(
      /different contribution kind/i,
    );
    expect(() => assertApprovalUsable({ ...base, decision: 'denied' }, target, claim, 'user-1')).toThrow(
      /not approved/i,
    );
    expect(() =>
      assertApprovalUsable({ ...base, policyVersion: 'localfirst/approval/v0.0' }, target, claim, 'user-1'),
    ).toThrow(/superseded/i);
  });

  it('requires every warning to be acknowledged', () => {
    expect(unacknowledgedWarnings(['A', 'B'], ['A'])).toEqual(['B']);
    expect(() => assertWarningsAcknowledged(['A', 'B'], ['A'])).toThrow(/acknowledged/i);
    expect(() => assertWarningsAcknowledged(['A'], ['A'])).not.toThrow();
    expect(() => assertApprovalUsable(base, { ...target, warningCodes: ['WARN_TWO'] }, claim, 'user-1')).toThrow(
      /acknowledged/i,
    );
  });
});

describe('slugs', () => {
  it('produces stable, safe slugs and avoids reserved words', () => {
    expect(slugify('Local Request Labeler!')).toBe('local-request-labeler');
    expect(slugify('  Ünïcödé  Näme ')).toBe('unicode-name');
    expect(isReservedSlug('projects')).toBe(true);
    expect(slugCandidates('Projects', 'projects')).not.toContain('projects');
    expect(slugCandidates('My Tool', 'my-tool')[0]).toBe('my-tool');
  });
});

describe('configuration validation', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost:5432/x',
    API_BASE_URL: 'https://api.localfirst.sh',
    WEBSITE_URL: 'https://localfirst.sh',
    AUTH_SECRET: 'a'.repeat(40),
  };

  it('derives distinct MCP and REST audiences from one origin', () => {
    const config = loadConfig({ ...base } as NodeJS.ProcessEnv);
    expect(config.mcpResource).toBe('https://api.localfirst.sh/mcp');
    expect(config.restResource).toBe('https://api.localfirst.sh/api/v1');
    expect(config.authIssuer).toBe('https://api.localfirst.sh/api/auth');
    expect(config.mcpResource).not.toBe(config.restResource);
  });

  it('rejects a production configuration that is unsafe', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', API_BASE_URL: 'http://api.localfirst.sh' } as NodeJS.ProcessEnv),
    ).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', AUTH_SECRET: 'short' } as NodeJS.ProcessEnv),
    ).toThrow(/AUTH_SECRET/);
    expect(() =>
      loadConfig({
        ...base,
        NODE_ENV: 'production',
        GITHUB_CLIENT_ID: 'id',
        GITHUB_CLIENT_SECRET: 'secret',
        DEV_AUTH_ENABLED: 'true',
      } as NodeJS.ProcessEnv),
    ).toThrow(/DEV_AUTH_ENABLED/);
  });

  it('rejects wildcard trusted origins and dependent feature flags', () => {
    expect(() =>
      loadConfig({ ...base, TRUSTED_ORIGINS: 'https://*.example.org' } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(() =>
      loadConfig({
        ...base,
        FEATURE_RESULT_SUBMISSION: 'true',
        FEATURE_TEST_DEFINITIONS: 'false',
      } as NodeJS.ProcessEnv),
    ).toThrow(/FEATURE_TEST_DEFINITIONS/);
  });

  it('keeps secrets out of the logged summary', async () => {
    const { configSummary } = await import('../src/config.js');
    const summary = JSON.stringify(configSummary(loadConfig({ ...base } as NodeJS.ProcessEnv)));
    expect(summary).not.toContain('a'.repeat(40));
    expect(summary).not.toContain('postgres://');
  });
});
