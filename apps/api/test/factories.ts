/**
 * Test factories. Accounts and projects are created through the same services
 * the API uses, so a test can never bypass a policy the product enforces.
 */

import { randomUUID } from 'node:crypto';
import { db } from '../src/db/client.js';
import { operatorRoles, userProfiles } from '../src/db/schema/registry.js';
import { userTable } from '../src/db/schema/auth.js';
import type { Actor } from '../src/http/context.js';
import { P0_SCOPES, P1_SCOPES } from '../src/auth/scopes.js';
import {
  createApproval,
  createDirectProjectDraft,
  revalidateDraft,
} from '../src/services/drafts.js';
import { publishProjectDraft } from '../src/services/publication.js';
import { createApp } from '../src/app.js';

export interface TestAccount {
  userId: string;
  handle: string;
  actor: Actor;
}

export async function createAccount(
  options: { handle?: string; operator?: boolean; suspended?: boolean } = {},
): Promise<TestAccount> {
  const userId = `user-${randomUUID()}`;
  const handle = options.handle ?? `tester-${userId.slice(5, 13)}`;
  const now = new Date();
  await db().insert(userTable).values({
    id: userId,
    name: handle,
    email: `${handle}@test.localfirst.invalid`,
    emailVerified: false,
    image: null,
    createdAt: now,
    updatedAt: now,
  });
  await db()
    .insert(userProfiles)
    .values({
      userId,
      handle,
      displayName: handle,
      externalIdentities: [],
      suspendedAt: options.suspended ? now : null,
      suspendedReason: options.suspended ? 'test suspension' : null,
    });
  if (options.operator) {
    await db().insert(operatorRoles).values({ userId, role: 'admin', grantedReason: 'test' });
  }
  return {
    userId,
    handle,
    actor: {
      kind: 'session',
      userId,
      sessionId: `session-${randomUUID()}`,
      operatorRoles: options.operator ? ['admin'] : [],
      scopes: new Set<string>([...P0_SCOPES, ...P1_SCOPES, 'community:write', 'community:publish']),
    },
  };
}

export interface ProjectDocumentOptions {
  key?: string;
  name?: string;
  type?: string;
  categories?: string[];
  testSupport?: string;
  sources?: string;
  hardware?: string;
  runtimes?: string;
  models?: string;
  dataBoundary?: string;
  extraFrontmatter?: string;
}

/** A minimal valid PROJECT.md, with hooks for per-test variation. */
export function projectDocument(options: ProjectDocumentOptions = {}): string {
  const key = options.key ?? 'test-project';
  const name = options.name ?? 'Test Project';
  return `---
schema: localfirst/project/v0.2
project:
  key: ${key}
  name: ${name}
  summary: A documentation entry used by the automated test suite for the registry.
  type: ${options.type ?? 'documentation'}
  categories: [${(options.categories ?? ['documentation']).join(', ')}]
  version: "0.1.0"
  license: {state: known, id: CC-BY-4.0, reference: "https://creativecommons.org/licenses/by/4.0/"}
sources:
${
  options.sources ??
  `  - key: notes
    kind: authored_specification
    url: null
    revision: null
    content_digest: null
    license: {state: known, id: CC-BY-4.0, reference: "https://creativecommons.org/licenses/by/4.0/"}`
}
attribution:
  authors: [{name: Test Author, url: null}]
  relationship: original_author_claimed
models: ${options.models ?? '{state: unknown, roles: []}'}
runtimes: ${options.runtimes ?? '{state: unknown, supported: []}'}
hardware: ${options.hardware ?? '{state: unknown, architectures: [], minimum_memory_bytes: null, accelerator: unknown, devices: []}'}
operating_systems: {state: unknown, supported: []}
dependencies: {state: unknown, items: []}
configurations:
  - key: reading-only
    model_roles: []
    setup_kind: unsupported
    workload: {context_tokens: null, concurrency: null}
data_boundary: ${options.dataBoundary ?? '{inference: unknown, storage: local, runtime_network: unknown, external_services: []}'}
test_support: ${options.testSupport ?? 'none'}
tests: []
limitations:
  - This test entry claims nothing about any machine, model, or runtime.
evidence: []
media: []
derivative_of: null
${options.extraFrontmatter ?? ''}---

## Purpose

Exercise the registry contribution path with a documentation-only entry.

## Architecture and workflow

None: this is a documentation record.

## Setup

Nothing to set up.

## Execution

Nothing executes.

## Test and evaluation

No test support is declared, and nothing has been run.

## Limitations

- It describes no hardware, model, or runtime.

## Sources and attribution

Authored for the automated test suite.
`;
}

export interface PublishedProject {
  projectId: string;
  projectVersionId: string;
  slug: string;
  draftId: string;
  contentDigest: string;
  warningCodes: string[];
}

/** Publish through draft, approval, and publication exactly as a client must. */
export async function publishProject(
  account: TestAccount,
  document = projectDocument(),
  files: Array<{ path: string; content: string }> = [],
): Promise<PublishedProject> {
  const { draft } = await createDirectProjectDraft({
    actor: account.actor,
    ownerUserId: account.userId,
    projectId: null,
    payload: { project_md: document, files },
  });
  const { draft: validated, validation } = await revalidateDraft(account.actor, draft.id);
  if (!validation.readyForReview) {
    throw new Error(
      `fixture is not publishable: ${JSON.stringify(validation.issues.filter((i) => i.severity === 'error'))}`,
    );
  }
  const { approvalId } = await createApproval({
    actor: account.actor,
    draftId: validated.id,
    draftRevision: validated.revision,
    payloadDigest: validated.payloadDigest,
    acknowledgedWarningCodes: validation.warning_codes,
    decision: 'approved',
    sessionId: 'test-session',
  });
  const published = await publishProjectDraft({
    actor: account.actor,
    draftId: validated.id,
    approvalId: approvalId as string,
    draftRevision: validated.revision,
    payloadDigest: validated.payloadDigest,
  });
  return {
    projectId: published.project_id,
    projectVersionId: published.project_version_id,
    slug: published.slug,
    draftId: validated.id,
    contentDigest: published.content_digest,
    warningCodes: published.warning_codes,
  };
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Dev-auth identity: a human session unless `actorKind` is `token`. */
  user?: string;
  scopes?: string[];
  actorKind?: 'session' | 'token';
  idempotencyKey?: string;
  ifMatch?: string;
}

const app = createApp();

export async function request(
  path: string,
  options: RequestOptions = {},
): Promise<{ status: number; json: any; headers: Headers; text: string }> {
  const headers = new Headers(options.headers ?? {});
  if (options.body !== undefined) headers.set('content-type', 'application/json');
  if (options.user) headers.set('x-dev-user', options.user);
  if (options.scopes) headers.set('x-dev-scopes', options.scopes.join(' '));
  if (options.actorKind === 'token') headers.set('x-dev-actor', 'token');
  if (options.idempotencyKey) headers.set('idempotency-key', options.idempotencyKey);
  if (options.ifMatch) headers.set('if-match', options.ifMatch);

  const response = await app.fetch(
    new Request(`http://127.0.0.1:8788${path}`, {
      method: options.method ?? 'GET',
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    }),
  );
  const text = await response.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json: json as any, headers: response.headers, text };
}
