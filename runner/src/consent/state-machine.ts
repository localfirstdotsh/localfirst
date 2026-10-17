/**
 * Local execution state machine (BACKEND_PRD section 7.1).
 *
 *   spec_retrieved -> local_discovery_authorized -> preflight -> plan_reviewed
 *   -> execution_authorized -> running -> local_report_saved
 *   -> export_reviewed -> upload_authorized -> private_submission
 *   -> public_contribution_approved -> published
 *
 * Every authorizing stage needs its own evidence; nothing carries over from a
 * previous stage, and a stage cannot be skipped. Cancelling keeps a partial
 * report requirement and is terminal: the machine has no retry, so nothing
 * silently reruns inference or resubmits data.
 */

export const LOCAL_STAGES = [
  'spec_retrieved',
  'local_discovery_authorized',
  'preflight',
  'plan_reviewed',
  'execution_authorized',
  'running',
  'local_report_saved',
] as const;

export const SHARING_STAGES = [
  'export_reviewed',
  'upload_authorized',
  'private_submission',
  'public_contribution_approved',
  'published',
] as const;

export const STAGES = [...LOCAL_STAGES, ...SHARING_STAGES] as const;
export type Stage = (typeof STAGES)[number];
export type MachineState = Stage | 'cancelled' | 'failed';

export type ApprovalChannel = 'interactive_tty' | 'stored_approval' | 'browser_confirmation';

/** Evidence the caller must present to enter each stage. */
export interface EvidenceByStage {
  spec_retrieved: { project_manifest_digest: string };
  /**
   * `approved_plan` records that a run reaches the runtime endpoint because an
   * approved plan already names it (the endpoint was authorized when planned).
   */
  local_discovery_authorized: {
    runtime: 'ollama' | 'lmstudio';
    endpoint: string;
    channel: 'interactive_tty' | 'approved_plan';
  };
  preflight: Record<string, never>;
  plan_reviewed: { plan_digest: string };
  execution_authorized: { plan_digest: string; channel: 'interactive_tty' | 'stored_approval' };
  running: { plan_digest: string; bundle_verified: true };
  local_report_saved: { report_digest: string };
  export_reviewed: { payload_digest: string };
  upload_authorized: { payload_digest: string; registry_origin: string; channel: 'interactive_tty' };
  private_submission: { payload_digest: string; submission_id: string };
  public_contribution_approved: { payload_digest: string; channel: 'browser_confirmation' };
  published: Record<string, never>;
}

export type ConsentErrorCode =
  | 'terminal_state'
  | 'stage_skipped'
  | 'evidence_invalid'
  | 'digest_mismatch'
  | 'stage_not_reached';

export class ConsentError extends Error {
  readonly code: ConsentErrorCode;
  constructor(code: ConsentErrorCode, message: string) {
    super(message);
    this.name = 'ConsentError';
    this.code = code;
  }
}

export interface HistoryEntry {
  state: MachineState;
  at: string;
  detail: Record<string, unknown>;
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const isDigest = (value: unknown): value is string => typeof value === 'string' && DIGEST.test(value);

export class ConsentSession {
  private current: MachineState = 'spec_retrieved';
  private readonly log: HistoryEntry[] = [];
  private reviewedPlan: string | null = null;
  private authorizedPlan: string | null = null;
  private exportDigest: string | null = null;
  private partialReport = false;

  constructor(
    spec: EvidenceByStage['spec_retrieved'],
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!isDigest(spec.project_manifest_digest)) {
      throw new ConsentError('evidence_invalid', 'spec_retrieved needs a project manifest digest');
    }
    this.record('spec_retrieved', { ...spec });
  }

  /**
   * Continue in a new process from a saved artifact: a local report on disk
   * (`local_report_saved`) or a reviewed export file (`export_reviewed`). The
   * earlier stages are not replayed or faked; the history records the resume.
   */
  static resume(
    stage: 'local_report_saved' | 'export_reviewed',
    evidence: { project_manifest_digest: string; report_digest?: string; payload_digest?: string },
    now: () => Date = () => new Date(),
  ): ConsentSession {
    const session = new ConsentSession({ project_manifest_digest: evidence.project_manifest_digest }, now);
    const digest = stage === 'local_report_saved' ? evidence.report_digest : evidence.payload_digest;
    if (!isDigest(digest)) throw new ConsentError('evidence_invalid', `resume at ${stage} needs a digest`);
    if (stage === 'export_reviewed') session.exportDigest = digest;
    session.record(stage, { resumed: true, digest });
    return session;
  }

  get state(): MachineState {
    return this.current;
  }

  get history(): readonly HistoryEntry[] {
    return this.log;
  }

  /** True when a cancelled or failed run still owes a local partial report. */
  get partialReportRequired(): boolean {
    return this.partialReport;
  }

  /**
   * Enter the next stage. Only the immediately following stage is reachable,
   * and only with evidence for that stage.
   */
  advance<S extends Exclude<Stage, 'spec_retrieved'>>(to: S, evidence: EvidenceByStage[S]): void {
    if (this.current === 'cancelled' || this.current === 'failed') {
      throw new ConsentError('terminal_state', `session is ${this.current}; start a new session`);
    }
    const index = STAGES.indexOf(this.current);
    const target = STAGES.indexOf(to);
    if (target !== index + 1) {
      throw new ConsentError(
        'stage_skipped',
        `cannot go from ${this.current} to ${to}; the next stage is ${STAGES[index + 1] ?? 'none'}`,
      );
    }
    this.validate(to, evidence as unknown as Record<string, unknown>);
    this.record(to, { ...(evidence as Record<string, unknown>) });
  }

  /** Cancel at any non-terminal stage. A cancelled run preserves a partial report. */
  cancel(reason: string): { partialReportRequired: boolean } {
    if (this.current === 'cancelled' || this.current === 'failed') {
      throw new ConsentError('terminal_state', `session is already ${this.current}`);
    }
    this.partialReport = this.current === 'running' || this.current === 'execution_authorized';
    this.record('cancelled', { reason, from: this.current });
    return { partialReportRequired: this.partialReport };
  }

  /** Record a failure. Like cancel, it is terminal and never retries. */
  fail(reason: string): { partialReportRequired: boolean } {
    if (this.current === 'cancelled' || this.current === 'failed') {
      throw new ConsentError('terminal_state', `session is already ${this.current}`);
    }
    this.partialReport = this.current === 'running';
    this.record('failed', { reason, from: this.current });
    return { partialReportRequired: this.partialReport };
  }

  /** Confirm the partial report was saved after a cancel or failure. */
  markPartialReportSaved(reportDigest: string): void {
    if (!this.partialReport) {
      throw new ConsentError('stage_not_reached', 'no partial report is owed');
    }
    if (!isDigest(reportDigest)) throw new ConsentError('evidence_invalid', 'report digest is malformed');
    this.partialReport = false;
    this.log.push({ state: this.current, at: this.now().toISOString(), detail: { partial_report_digest: reportDigest } });
  }

  private record(state: MachineState, detail: Record<string, unknown>): void {
    this.current = state;
    this.log.push({ state, at: this.now().toISOString(), detail });
  }

  private validate(stage: Stage, evidence: Record<string, unknown>): void {
    const need = (name: string, ok: boolean) => {
      if (!ok) throw new ConsentError('evidence_invalid', `${stage} needs a valid ${name}`);
    };
    const same = (name: string, expected: string | null, actual: unknown) => {
      if (expected === null || actual !== expected) {
        throw new ConsentError('digest_mismatch', `${stage} ${name} does not match the earlier stage`);
      }
    };
    switch (stage) {
      case 'local_discovery_authorized':
        need('runtime', evidence.runtime === 'ollama' || evidence.runtime === 'lmstudio');
        need('endpoint', typeof evidence.endpoint === 'string' && evidence.endpoint.length > 0);
        need('discovery approval', evidence.channel === 'interactive_tty' || evidence.channel === 'approved_plan');
        return;
      case 'preflight':
        return;
      case 'plan_reviewed':
        need('plan digest', isDigest(evidence.plan_digest));
        this.reviewedPlan = evidence.plan_digest as string;
        return;
      case 'execution_authorized':
        need('plan digest', isDigest(evidence.plan_digest));
        need(
          'approval channel',
          evidence.channel === 'interactive_tty' || evidence.channel === 'stored_approval',
        );
        same('plan digest', this.reviewedPlan, evidence.plan_digest);
        this.authorizedPlan = evidence.plan_digest as string;
        return;
      case 'running':
        need('verified bundle', evidence.bundle_verified === true);
        same('plan digest', this.authorizedPlan, evidence.plan_digest);
        return;
      case 'local_report_saved':
        need('report digest', isDigest(evidence.report_digest));
        return;
      case 'export_reviewed':
        need('payload digest', isDigest(evidence.payload_digest));
        this.exportDigest = evidence.payload_digest as string;
        return;
      case 'upload_authorized':
        need('payload digest', isDigest(evidence.payload_digest));
        need('registry origin', typeof evidence.registry_origin === 'string' && evidence.registry_origin.length > 0);
        need('interactive approval', evidence.channel === 'interactive_tty');
        same('payload digest', this.exportDigest, evidence.payload_digest);
        return;
      case 'private_submission':
        need('submission id', typeof evidence.submission_id === 'string' && evidence.submission_id.length > 0);
        same('payload digest', this.exportDigest, evidence.payload_digest);
        return;
      case 'public_contribution_approved':
        need('browser confirmation', evidence.channel === 'browser_confirmation');
        same('payload digest', this.exportDigest, evidence.payload_digest);
        return;
      case 'published':
        return;
      default:
        throw new ConsentError('stage_skipped', `unknown stage ${String(stage)}`);
    }
  }
}
