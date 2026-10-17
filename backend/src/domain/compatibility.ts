/**
 * Conservative compatibility assessment (BACKEND_PRD section 9.2).
 *
 * The algorithm resolves a visible immutable version and configuration,
 * normalizes voluntarily supplied facts, evaluates known requirements,
 * separates missing prerequisites from hard incompatibility, explains near
 * matches and unavailable facts, and returns one outcome with per-requirement
 * checks and provenance.
 *
 * Without accepted evidence the level is `claimed` or `documented` and
 * `evidence_match` is unreachable. With it (section 9.2 step 5), evidence is
 * matched by exact identities only: model artifact identity, runtime and
 * version, and platform must all be established by the caller's shared facts.
 * Accepted failures are included, a contradiction is surfaced as uncertainty
 * and never averaged, and component evidence never implies offline use or a
 * whole-project result. Evidence cannot override a known hard failure.
 */

import { matchSubject, type EvidenceSubject } from './evidence-match.js';
import {
  COMPATIBILITY_RULES_VERSION,
  type CompatibilityAssessment,
  type CompatibilityCheck,
  type CompatibilityRequest,
  type ProjectSpec,
} from '@localfirst/contracts';

export interface AssessmentInput {
  projectId: string;
  projectVersionId: string;
  spec: ProjectSpec;
  /** True when at least one source is revision- or digest-pinned. */
  sourcesPinned: boolean;
  request: CompatibilityRequest;
  /** Whether a supported runner exists for the declared harness. */
  runnerAvailable: boolean;
  /** Accepted-evidence summaries for exactly this project version. */
  evidence?: EvidenceInput[];
}

export interface EvidenceInput {
  id: string;
  configurationKey: string;
  subject: EvidenceSubject;
  testDefinitionId: string | null;
  scope: 'component' | 'workflow' | 'manual';
  evidenceLevel: 'community_reported' | 'reproducible_test' | 'independently_verified';
  counts: { reports: number; successes: number; failures: number; partial: number };
  distinctContributors: number;
  conflict: boolean;
  evidenceIds: string[];
}

const NO_EXACT_EVIDENCE_NOTE =
  'No exact tested configuration backs this assessment; `candidate` is not a guarantee.';
const CALLER_SOURCE = 'caller_supplied_environment';
const SELECTED_MODEL_SOURCE = 'caller_supplied_selected_model';
const SPEC_SOURCE = 'project_declaration';

export function assessCompatibility(input: AssessmentInput): CompatibilityAssessment {
  const { spec, request } = input;
  const checks: CompatibilityCheck[] = [];
  const blockers: string[] = [];
  const uncertainties: string[] = [];
  const missingPrerequisites: string[] = [];

  const configuration =
    spec.configurations.find((entry) => entry.key === request.configuration_key) ??
    (request.configuration_key === null ? spec.configurations[0] : undefined);

  if (!configuration) {
    return {
      project_id: input.projectId,
      project_version_id: input.projectVersionId,
      configuration_key: request.configuration_key,
      outcome: 'unknown',
      evidence_level: 'claimed',
      evidence_scope: 'requirements_only',
      rules_version: COMPATIBILITY_RULES_VERSION,
      checks: [
        {
          requirement: 'configuration',
          status: 'unknown',
          source: SPEC_SOURCE,
          detail: 'The requested configuration is not declared by this version.',
        },
      ],
      blockers: [],
      uncertainties: [
        `Configuration \`${request.configuration_key}\` is not declared by this project version.`,
      ],
      missing_prerequisites: [],
      evidence_ids: [],
      test_support: { declared_kind: spec.test_support, runner_available: input.runnerAvailable },
    };
  }

  if (request.configuration_key === null) {
    uncertainties.push(
      `No configuration was requested; the first declared configuration \`${configuration.key}\` was assessed.`,
    );
  }

  const sharedAnything =
    request.hardware !== null || request.runtime !== null || request.selected_models.length > 0;

  // --- Model roles, capabilities, and context capacity ---------------------
  const roles = spec.models.roles.filter(
    (role) => configuration.model_roles.length === 0 || configuration.model_roles.includes(role.key),
  );
  if (spec.models.state !== 'declared') {
    checks.push({
      requirement: 'model_requirements',
      status: 'unknown',
      source: SPEC_SOURCE,
      detail: `The project declares model requirements as \`${spec.models.state}\`.`,
    });
    uncertainties.push('The project does not declare its model requirements.');
  }

  for (const role of roles) {
    const selected = request.selected_models.find((entry) => entry.role === role.key);
    for (const capability of role.required_capabilities) {
      if (!selected) {
        checks.push({
          requirement: capability,
          status: 'unknown',
          source: 'no_supplied_model',
          detail: `No selected model was shared for role \`${role.key}\`.`,
        });
        continue;
      }
      if (selected.unsupported_capabilities.includes(capability)) {
        checks.push({
          requirement: capability,
          status: 'fail',
          source: SELECTED_MODEL_SOURCE,
          detail: `The shared model for role \`${role.key}\` reports \`${capability}\` as unsupported.`,
        });
        blockers.push(
          `The selected model for role \`${role.key}\` does not support \`${capability}\`.`,
        );
        continue;
      }
      if (selected.capabilities.includes(capability)) {
        checks.push({
          requirement: capability,
          status: 'pass',
          source: SELECTED_MODEL_SOURCE,
          detail: 'Reported by the caller for the model it selected locally.',
        });
        continue;
      }
      checks.push({
        requirement: capability,
        status: 'unknown',
        source: SELECTED_MODEL_SOURCE,
        detail: `The shared model summary does not state \`${capability}\`.`,
      });
    }

    if (role.minimum_context_tokens !== null) {
      if (!selected || selected.context_tokens === null) {
        checks.push({
          requirement: 'declared_minimum_context_tokens',
          status: 'unknown',
          source: selected ? SELECTED_MODEL_SOURCE : 'no_supplied_model',
          detail: `Role \`${role.key}\` declares ${role.minimum_context_tokens} context tokens; no effective context was shared.`,
        });
      } else if (selected.context_tokens >= role.minimum_context_tokens) {
        checks.push({
          requirement: 'declared_minimum_context_tokens',
          status: 'pass',
          source: SELECTED_MODEL_SOURCE,
          detail: `${selected.context_tokens} shared tokens meet the declared ${role.minimum_context_tokens}.`,
        });
      } else {
        checks.push({
          requirement: 'declared_minimum_context_tokens',
          status: 'fail',
          source: SELECTED_MODEL_SOURCE,
          detail: `${selected.context_tokens} shared tokens are below the declared ${role.minimum_context_tokens}.`,
        });
        blockers.push(
          `The selected model for role \`${role.key}\` has less context than the declared minimum.`,
        );
      }
    }

    if (selected && !selected.identity_known) {
      uncertainties.push(
        `The selected model for role \`${role.key}\` has incomplete artifact identity, which limits shared reproducibility.`,
      );
    }
    if (selected && role.substitution === 'not_allowed') {
      uncertainties.push(
        `Role \`${role.key}\` does not permit model substitution; a different model is a new build, not this project's configuration.`,
      );
    }
  }

  // --- Architecture, operating system, accelerator -------------------------
  if (spec.hardware.state === 'declared' && spec.hardware.architectures.length > 0) {
    const supplied = request.hardware?.cpu_architecture ?? null;
    if (supplied === null) {
      checks.push({
        requirement: 'cpu_architecture',
        status: 'unknown',
        source: 'no_supplied_hardware',
        detail: `Declared architectures: ${spec.hardware.architectures.join(', ')}.`,
      });
    } else if (spec.hardware.architectures.includes(supplied)) {
      checks.push({ requirement: 'cpu_architecture', status: 'pass', source: CALLER_SOURCE });
    } else {
      checks.push({
        requirement: 'cpu_architecture',
        status: 'fail',
        source: CALLER_SOURCE,
        detail: `\`${supplied}\` is not among the declared architectures ${spec.hardware.architectures.join(', ')}.`,
      });
      blockers.push('The declared architectures do not include the shared machine architecture.');
    }
  }

  if (spec.operating_systems.state === 'declared' && spec.operating_systems.supported.length > 0) {
    const supplied = request.hardware?.os ?? null;
    if (supplied === null) {
      checks.push({
        requirement: 'operating_system',
        status: 'unknown',
        source: 'no_supplied_hardware',
        detail: `Declared operating systems: ${spec.operating_systems.supported.join(', ')}.`,
      });
    } else if (spec.operating_systems.supported.includes(supplied)) {
      checks.push({ requirement: 'operating_system', status: 'pass', source: CALLER_SOURCE });
    } else {
      checks.push({
        requirement: 'operating_system',
        status: 'fail',
        source: CALLER_SOURCE,
        detail: `\`${supplied}\` is not among the declared operating systems.`,
      });
      blockers.push('The declared operating systems do not include the shared platform.');
    }
  }

  if (spec.hardware.accelerator === 'required') {
    const accelerator = request.hardware?.accelerator ?? null;
    if (accelerator === null) {
      checks.push({
        requirement: 'accelerator',
        status: 'unknown',
        source: 'no_supplied_hardware',
        detail: 'The project declares an accelerator as required.',
      });
    } else if (accelerator === 'cpu') {
      checks.push({
        requirement: 'accelerator',
        status: 'fail',
        source: CALLER_SOURCE,
        detail: 'The project declares an accelerator as required.',
      });
      blockers.push('This project declares an accelerator as required.');
    } else {
      checks.push({ requirement: 'accelerator', status: 'pass', source: CALLER_SOURCE });
    }
  }

  // --- Memory capacity ------------------------------------------------------
  // Bytes only, and unified memory is never counted twice (section 9.2).
  if (spec.hardware.minimum_memory_bytes !== null) {
    const memory = request.hardware?.memory_bytes ?? null;
    if (memory === null) {
      checks.push({
        requirement: 'declared_minimum_memory',
        status: 'unknown',
        source: 'no_supplied_hardware',
        detail: `The creator declares ${spec.hardware.minimum_memory_bytes} bytes as a minimum.`,
      });
    } else if (memory >= spec.hardware.minimum_memory_bytes) {
      checks.push({
        requirement: 'declared_minimum_memory',
        status: 'pass',
        source: 'supplied_hardware_and_creator_requirement',
        detail:
          'The declared minimum is a creator claim; it does not establish a measured model fit.',
      });
    } else {
      checks.push({
        requirement: 'declared_minimum_memory',
        status: 'fail',
        source: 'supplied_hardware_and_creator_requirement',
        detail: `${memory} shared bytes are below the declared ${spec.hardware.minimum_memory_bytes}.`,
      });
      blockers.push('The shared system memory is below the declared minimum.');
    }
    uncertainties.push(
      'Declared memory requirements exclude runtime, KV-cache, and concurrency overhead; recheck available memory locally before execution.',
    );
  }

  if (spec.hardware.minimum_vram_bytes !== null) {
    const unified = request.hardware?.unified_memory ?? null;
    const vram = request.hardware?.vram_bytes ?? null;
    if (unified === true) {
      checks.push({
        requirement: 'declared_minimum_vram',
        status: 'unknown',
        source: CALLER_SOURCE,
        detail:
          'The shared machine reports unified memory, so discrete VRAM cannot be compared separately.',
      });
    } else if (vram === null) {
      checks.push({
        requirement: 'declared_minimum_vram',
        status: 'unknown',
        source: 'no_supplied_hardware',
        detail: `The project declares ${spec.hardware.minimum_vram_bytes} bytes of accelerator memory.`,
      });
    } else if (vram >= spec.hardware.minimum_vram_bytes) {
      checks.push({ requirement: 'declared_minimum_vram', status: 'pass', source: CALLER_SOURCE });
    } else {
      checks.push({
        requirement: 'declared_minimum_vram',
        status: 'fail',
        source: CALLER_SOURCE,
        detail: `${vram} shared bytes are below the declared ${spec.hardware.minimum_vram_bytes}.`,
      });
      blockers.push('The shared accelerator memory is below the declared minimum.');
    }
  }

  // --- Runtime support ------------------------------------------------------
  if (spec.runtimes.state === 'declared' && spec.runtimes.supported.length > 0) {
    const families = spec.runtimes.supported.map((entry) => entry.family);
    const supplied = request.runtime?.family ?? null;
    if (supplied === null) {
      checks.push({
        requirement: 'runtime_family',
        status: 'unknown',
        source: 'no_supplied_runtime',
        detail: `Declared runtimes: ${families.join(', ')}.`,
      });
    } else if (families.includes(supplied)) {
      checks.push({
        requirement: 'runtime_family',
        status: 'pass',
        source: CALLER_SOURCE,
        detail: 'Runtime support is an author declaration that the registry has not exercised.',
      });
      const constraint = spec.runtimes.supported.find((entry) => entry.family === supplied)
        ?.version_constraint;
      if (constraint && !request.runtime?.version) {
        checks.push({
          requirement: 'runtime_version_constraint',
          status: 'unknown',
          source: 'no_supplied_runtime',
          detail: `The project declares the constraint \`${constraint}\`; no runtime version was shared.`,
        });
      }
    } else {
      checks.push({
        requirement: 'runtime_family',
        status: 'fail',
        source: CALLER_SOURCE,
        detail: `\`${supplied}\` is not among the declared runtimes ${families.join(', ')}.`,
      });
      blockers.push('The declared runtimes do not include the shared runtime family.');
    }
  }

  // --- Dependencies are installable prerequisites, not incompatibility -----
  if (spec.dependencies.state === 'declared' && spec.dependencies.items.length > 0) {
    for (const item of spec.dependencies.items) {
      missingPrerequisites.push(
        `${item.name}${item.version_constraint ? ` ${item.version_constraint}` : ''} (${item.kind})`,
      );
    }
    checks.push({
      requirement: 'declared_dependencies',
      status: 'unknown',
      source: SPEC_SOURCE,
      detail: 'Declared prerequisites are assessed on the local machine, not by the registry.',
    });
  } else if (spec.dependencies.state === 'unknown') {
    checks.push({
      requirement: 'declared_dependencies',
      status: 'unknown',
      source: SPEC_SOURCE,
      detail: 'The project does not declare its dependencies.',
    });
    uncertainties.push('Dependencies are unknown, so setup effort cannot be assessed.');
  }

  // --- Requested data boundary ---------------------------------------------
  const localRequested = request.requirements.inference === 'local_required';
  if (localRequested) {
    const remoteModel = request.selected_models.find(
      (entry) => entry.execution_location === 'remote',
    );
    const unknownLocation = request.selected_models.find(
      (entry) => entry.execution_location === 'unknown',
    );
    if (remoteModel) {
      checks.push({
        requirement: 'local_inference',
        status: 'fail',
        source: SELECTED_MODEL_SOURCE,
        detail: `The model shared for role \`${remoteModel.role}\` executes remotely.`,
      });
      blockers.push(
        'A local-only requirement cannot be satisfied by a model that executes remotely.',
      );
    } else if (spec.data_boundary.inference === 'external_allowed') {
      checks.push({
        requirement: 'local_inference',
        status: 'fail',
        source: SPEC_SOURCE,
        detail: 'The project permits external inference.',
      });
      blockers.push('This project does not declare a local-only inference boundary.');
    } else if (unknownLocation || request.selected_models.length === 0) {
      checks.push({
        requirement: 'local_inference',
        status: 'unknown',
        source: unknownLocation ? SELECTED_MODEL_SOURCE : 'no_supplied_model',
        detail:
          'Execution locality must be established by a local preflight check; an assertion is not a locality check.',
      });
      uncertainties.push(
        'Local-only execution was requested but locality has not been established, so a plan claiming it is blocked.',
      );
    } else {
      checks.push({
        requirement: 'local_inference',
        status: 'pass',
        source: SELECTED_MODEL_SOURCE,
        detail: 'The caller reports a locally executing model; the registry did not observe it.',
      });
    }
  }

  if (request.requirements.offline) {
    const offlineCapable =
      spec.data_boundary.inference === 'local_required' &&
      spec.data_boundary.runtime_network === 'none' &&
      spec.data_boundary.external_services.length === 0;
    checks.push({
      requirement: 'offline',
      status: 'unknown',
      source: offlineCapable ? SPEC_SOURCE : 'no_applicable_test',
      detail: offlineCapable
        ? 'The project declares no runtime network use, but no offline check has been observed.'
        : 'Runtime network behaviour is not declared as `none`, and no offline check has been observed.',
    });
    uncertainties.push(
      'Offline operation has not been observed; an offline claim needs a documented egress restriction covering the runtime process.',
    );
  } else {
    checks.push({
      requirement: 'offline',
      status: 'unknown',
      source: 'no_applicable_test',
      detail: 'Offline operation was not requested and has not been observed.',
    });
  }

  if (request.requirements.accelerator === 'none' && spec.hardware.accelerator === 'required') {
    blockers.push('The caller requires no accelerator while the project declares one as required.');
  }

  // --- Outcome -------------------------------------------------------------
  const criticalRequirements = new Set([
    'cpu_architecture',
    'operating_system',
    'runtime_family',
    'declared_minimum_memory',
    'declared_minimum_vram',
    'declared_minimum_context_tokens',
    'accelerator',
    'local_inference',
    'model_requirements',
    ...roles.flatMap((role) => role.required_capabilities),
  ]);
  if (request.requirements.offline) criticalRequirements.add('offline');

  const hasFailure = checks.some((check) => check.status === 'fail') || blockers.length > 0;
  const criticalUnknown = checks.some(
    (check) => check.status === 'unknown' && criticalRequirements.has(check.requirement),
  );

  let outcome: CompatibilityAssessment['outcome'];
  if (hasFailure) {
    outcome = 'incompatible';
  } else if (!sharedAnything) {
    outcome = 'unknown';
    uncertainties.unshift(
      'No environment was shared, so only the declared requirements are listed; nothing about a specific machine was assessed.',
    );
  } else if (criticalUnknown) {
    outcome = 'unknown';
  } else {
    outcome = 'candidate';
    uncertainties.push(NO_EXACT_EVIDENCE_NOTE);
  }

  let evidenceLevel: CompatibilityAssessment['evidence_level'] = input.sourcesPinned
    ? 'documented'
    : 'claimed';
  let evidenceScope: CompatibilityAssessment['evidence_scope'] = 'requirements_only';
  const evidenceIds: string[] = [];

  // --- Accepted evidence (section 9.2 step 5) ------------------------------
  // Evidence never overrides a known hard failure, and it is matched on exact
  // identities only.
  const evidence = (input.evidence ?? []).filter((entry) => entry.configurationKey === configuration.key);
  if (evidence.length > 0 && !hasFailure && sharedAnything) {
    const matched = evidence.map((entry) => ({ entry, match: matchSubject(entry.subject, request) }));
    const exact = matched.filter((item) => item.match.exact);
    const near = matched.filter((item) => !item.match.exact);

    const strong = exact.filter(({ entry }) => ['reproducible_test', 'independently_verified'].includes(entry.evidenceLevel));
    const community = exact.filter(({ entry }) => entry.evidenceLevel === 'community_reported');
    const supporting = strong.filter(({ entry }) => entry.counts.successes > 0 && !entry.conflict && entry.counts.failures === 0);
    const failing = strong.filter(({ entry }) => entry.counts.failures > 0);

    if (strong.length > 0) {
      for (const { entry } of strong) evidenceIds.push(...entry.evidenceIds);
    }
    if (failing.length > 0) {
      const onlyFailures = failing.every(({ entry }) => entry.counts.successes === 0);
      checks.push({
        requirement: 'accepted_evidence',
        status: 'unknown',
        source: 'accepted_reproducible_test',
        detail: onlyFailures
          ? 'Accepted reproducible reports for this exact configuration record failures.'
          : 'Accepted reproducible reports for this exact configuration conflict: some succeeded and some failed.',
      });
      uncertainties.push(
        onlyFailures
          ? 'Accepted evidence for this exact configuration reports failures; it is not treated as compatible.'
          : 'Accepted evidence for this exact configuration conflicts; the disagreement is shown, not averaged.',
      );
      if (outcome === 'candidate') outcome = 'unknown';
      evidenceLevel = failing.some(({ entry }) => entry.evidenceLevel === 'independently_verified') ? 'independently_verified' : 'reproducible_test';
      evidenceScope = strong.every(({ entry }) => entry.scope === 'workflow') ? 'workflow' : 'component';
    } else if (supporting.length > 0 && outcome === 'candidate') {
      outcome = 'evidence_match';
      // Only the groups that justify the match may raise its level.
      evidenceLevel = supporting.some(({ entry }) => entry.evidenceLevel === 'independently_verified') ? 'independently_verified' : 'reproducible_test';
      evidenceScope = strong.every(({ entry }) => entry.scope === 'workflow') ? 'workflow' : 'component';
      checks.push({
        requirement: 'accepted_evidence',
        status: 'pass',
        source: 'accepted_reproducible_test',
        detail: `${supporting.length} accepted reproducible report group(s) match this exact build, runtime, and platform at ${evidenceScope} scope.`,
      });
      const groupCount = supporting.length;
      // Replace only the absence-of-evidence note; other uncertainties (offline, unknowns) stay.
      const absence = uncertainties.indexOf(NO_EXACT_EVIDENCE_NOTE);
      if (absence >= 0) uncertainties.splice(absence, 1);
      uncertainties.push(
        `Evidence at ${evidenceScope} scope from ${groupCount} qualifying group(s), with distinct contributors counted per group; it does not establish offline use, a complete project, or other hardware.`,
      );
    } else if (community.length > 0) {
      for (const { entry } of community) evidenceIds.push(...entry.evidenceIds);
      evidenceLevel = 'community_reported';
      checks.push({
        requirement: 'accepted_evidence',
        status: 'unknown',
        source: 'accepted_community_report',
        detail: 'Accepted community reports match, but they are claims, not a reproducible test.',
      });
      uncertainties.push(
        'Only community-reported evidence matches this configuration; it does not make this an evidence match.',
      );
    }

    if (exact.length === 0 && near.length > 0) {
      const reasons = [...new Set(near.flatMap(({ match }) => match.unmatched))].slice(0, 8);
      uncertainties.push(
        `Accepted evidence exists for ${near.length} other build or platform configuration(s) of this project, but none is established as an exact match by the shared facts (${reasons.join(', ')}).`,
      );
    }
  }

  return {
    project_id: input.projectId,
    project_version_id: input.projectVersionId,
    configuration_key: configuration.key,
    outcome,
    evidence_level: evidenceLevel,
    evidence_scope: evidenceScope,
    rules_version: COMPATIBILITY_RULES_VERSION,
    checks,
    blockers: [...new Set(blockers)],
    uncertainties: [...new Set(uncertainties)],
    missing_prerequisites: missingPrerequisites,
    evidence_ids: [...new Set(evidenceIds)],
    test_support: { declared_kind: spec.test_support, runner_available: input.runnerAvailable },
  };
}
