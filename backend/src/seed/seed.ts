/**
 * Development seed (BACKEND_PRD sections 15.4, 21, 22.2).
 *
 * Seeding uses the real contribution path: draft, validate, human approval of
 * the exact artifact, then publish. Nothing is inserted behind the policy, so a
 * seeded catalog proves the publication pipeline actually works.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { closeDatabase, db } from '../db/client.js';
import { hardwareDescriptors, operatorRoles, runtimeReferences, userProfiles } from '../db/schema/registry.js';
import { userTable } from '../db/schema/auth.js';
import { config } from '../config.js';
import { createLogger } from '../observability/logger.js';
import type { Actor } from '../http/context.js';
import { P0_SCOPES, P1_SCOPES } from '../auth/scopes.js';
import {
  createApproval,
  createDirectProjectDraft,
  revalidateDraft,
} from '../services/drafts.js';
import { publishProjectDraft } from '../services/publication.js';
import { reindexProject } from '../services/search.js';
import {
  SEED_HARDWARE_DESCRIPTORS,
  SEED_RUNTIME_REFERENCES,
  seedDocuments,
} from './entries.js';

const log = createLogger('seed');

interface SeedAccount {
  userId: string;
  handle: string;
  displayName: string;
  email: string;
  operator: boolean;
}

const ACCOUNTS: Record<'curator' | 'builder', SeedAccount> = {
  curator: {
    userId: 'seed-user-curator',
    handle: 'localfirst-curation',
    displayName: 'Localfirst curation',
    email: 'curation@seed.localfirst.invalid',
    operator: true,
  },
  builder: {
    userId: 'seed-user-builder',
    handle: 'example-builder',
    displayName: 'Localfirst example builder',
    email: 'builder@seed.localfirst.invalid',
    operator: false,
  },
};

function seedActor(account: SeedAccount): Actor {
  return {
    kind: 'session',
    userId: account.userId,
    sessionId: `seed-session-${randomUUID()}`,
    operatorRoles: account.operator ? ['admin'] : [],
    scopes: new Set<string>([...P0_SCOPES, ...P1_SCOPES]),
  };
}

async function ensureAccount(account: SeedAccount): Promise<void> {
  const now = new Date();
  await db()
    .insert(userTable)
    .values({
      id: account.userId,
      name: account.displayName,
      email: account.email,
      emailVerified: false,
      image: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  await db()
    .insert(userProfiles)
    .values({
      userId: account.userId,
      handle: account.handle,
      displayName: account.displayName,
      externalIdentities: [],
    })
    .onConflictDoNothing();
  if (account.operator) {
    // Operator privileges are administratively assigned, never inferred.
    await db()
      .insert(operatorRoles)
      .values({
        userId: account.userId,
        role: 'admin',
        grantedByUserId: null,
        grantedReason: 'Development seed operator account.',
      })
      .onConflictDoNothing();
  }
}

async function seedReferences(): Promise<void> {
  for (const descriptor of SEED_HARDWARE_DESCRIPTORS) {
    await db()
      .insert(hardwareDescriptors)
      .values(descriptor)
      .onConflictDoUpdate({
        target: hardwareDescriptors.key,
        set: {
          displayName: descriptor.displayName,
          platform: descriptor.platform,
          cpuArchitecture: descriptor.cpuArchitecture,
          accelerator: descriptor.accelerator,
          docsUrl: descriptor.docsUrl,
          details: descriptor.details,
        },
      });
  }
  for (const runtime of SEED_RUNTIME_REFERENCES) {
    await db()
      .insert(runtimeReferences)
      .values(runtime)
      .onConflictDoUpdate({
        target: runtimeReferences.family,
        set: {
          displayName: runtime.displayName,
          apiProfile: runtime.apiProfile,
          supportStatus: runtime.supportStatus,
          docsUrl: runtime.docsUrl,
          details: runtime.details,
        },
      });
  }
}

export interface SeedResult {
  published: Array<{ slug: string; project_id: string; warnings: number }>;
  skipped: Array<{ reason: string; detail: string }>;
}

export async function runSeed(): Promise<SeedResult> {
  if (config().isProduction) {
    throw new Error('The development seed must not run against production.');
  }
  await ensureAccount(ACCOUNTS.curator);
  await ensureAccount(ACCOUNTS.builder);
  await seedReferences();

  const result: SeedResult = { published: [], skipped: [] };

  for (const document of seedDocuments()) {
    const account = ACCOUNTS[document.submitter];
    const actor = seedActor(account);
    const { draft } = await createDirectProjectDraft({
      actor,
      ownerUserId: account.userId,
      projectId: null,
      payload: { project_md: document.project_md, files: document.files },
    });
    const { draft: validated, validation } = await revalidateDraft(actor, draft.id);

    if (!validation.readyForReview) {
      const errors = validation.issues.filter((issue) => issue.severity === 'error');
      result.skipped.push({
        reason: 'validation_failed',
        detail: `${validation.proposedSlug ?? draft.id}: ${errors.map((issue) => `${issue.code}@${issue.pointer}`).join(', ')}`,
      });
      log.warn({ draft_id: draft.id, errors }, 'seed entry failed validation');
      continue;
    }

    // The seed acts as the human reviewer, acknowledging every warning on the
    // exact artifact, exactly as the browser review page requires.
    const { approvalId } = await createApproval({
      actor,
      draftId: validated.id,
      draftRevision: validated.revision,
      payloadDigest: validated.payloadDigest,
      acknowledgedWarningCodes: validation.warning_codes,
      decision: 'approved',
      sessionId: `seed-session-${randomUUID()}`,
    });
    if (!approvalId) {
      result.skipped.push({ reason: 'approval_missing', detail: validated.id });
      continue;
    }

    const published = await publishProjectDraft({
      actor,
      draftId: validated.id,
      approvalId,
      draftRevision: validated.revision,
      payloadDigest: validated.payloadDigest,
    });
    await reindexProject(published.project_id);
    result.published.push({
      slug: published.slug,
      project_id: published.project_id,
      warnings: published.warning_codes.length,
    });
    log.info(
      {
        slug: published.slug,
        version: published.version_number,
        evidence_level: published.evidence_level,
        warnings: published.warning_codes.length,
      },
      'seed entry published',
    );
  }
  return result;
}

/** Remove seeded rows so the seed can be re-run from a clean state. */
export async function clearSeed(): Promise<void> {
  if (config().isProduction) throw new Error('refusing to clear production data');
  await db().execute(sql`
    delete from projects where manager_user_id in ('seed-user-curator', 'seed-user-builder')
  `);
  await db().delete(userTable).where(eq(userTable.id, 'seed-user-curator'));
  await db().delete(userTable).where(eq(userTable.id, 'seed-user-builder'));
}

const isEntryPoint = process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js');
if (isEntryPoint) {
  if (process.argv.includes('--reset')) await clearSeed();
  const result = await runSeed();
  log.info(
    { published: result.published.length, skipped: result.skipped.length },
    'seed complete',
  );
  for (const skipped of result.skipped) log.warn(skipped, 'seed entry skipped');
  await closeDatabase();
}
