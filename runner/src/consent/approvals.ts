import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { ExecutionGrant } from './plan.js';

const DIGEST = /^sha256:([0-9a-f]{64})$/;

export interface StoredApproval {
  schema: 'localfirst/local-approval/v0.1';
  plan_digest: string;
  approved_at: string;
  channel: 'interactive_tty';
}

/**
 * Approvals a noninteractive run may rely on. Each file is bound to one plan
 * digest, created only from an interactive grant, and re-validated on read.
 * A manifest's `allow_run` is never consulted here (BACKEND_PRD section 7.2).
 */
export class ApprovalStore {
  constructor(
    private readonly directory: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private fileFor(planDigest: string): string {
    const match = DIGEST.exec(planDigest);
    if (!match) throw new Error('plan digest is malformed');
    return join(this.directory, `${match[1]}.json`);
  }

  /** Persist an approval. Only an interactive grant is accepted. */
  async save(grant: ExecutionGrant): Promise<StoredApproval> {
    if (grant.channel !== 'interactive_tty') {
      throw new Error('only an interactive approval can be stored');
    }
    const approval: StoredApproval = {
      schema: 'localfirst/local-approval/v0.1',
      plan_digest: grant.plan_digest,
      approved_at: this.now().toISOString(),
      channel: 'interactive_tty',
    };
    const file = this.fileFor(grant.plan_digest);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(approval, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    return approval;
  }

  /** The stored approval for exactly this digest, or null when absent or malformed. */
  async find(planDigest: string): Promise<StoredApproval | null> {
    let text: string;
    try {
      text = await readFile(this.fileFor(planDigest), 'utf8');
    } catch {
      return null;
    }
    try {
      const value = JSON.parse(text) as Record<string, unknown>;
      const keys = Object.keys(value).sort().join(',');
      if (
        keys === 'approved_at,channel,plan_digest,schema' &&
        value.schema === 'localfirst/local-approval/v0.1' &&
        value.plan_digest === planDigest &&
        value.channel === 'interactive_tty' &&
        typeof value.approved_at === 'string'
      ) {
        return value as unknown as StoredApproval;
      }
    } catch {
      // fall through: a malformed file is not an approval
    }
    return null;
  }

  async revoke(planDigest: string): Promise<void> {
    await rm(this.fileFor(planDigest), { force: true });
  }

  /** A grant usable by a noninteractive run, only when a valid stored approval exists. */
  async grantFor(planDigest: string): Promise<(ExecutionGrant & { channel: 'stored_approval' }) | null> {
    const approval = await this.find(planDigest);
    return approval ? { plan_digest: approval.plan_digest, channel: 'stored_approval' } : null;
  }
}
