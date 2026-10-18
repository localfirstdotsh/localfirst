/**
 * Schema and migration checks (BACKEND_PRD sections 16.2, 16.4, 20.4).
 */

import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { getSchema } from 'better-auth/db';
import { db } from '../src/db/client.js';
import { AUTH_MODELS, AUTH_SCHEMA } from '../src/db/schema/auth.js';
import { buildAuthOptions } from '../src/auth/options.js';
import { config } from '../src/config.js';
import { createAccount, projectDocument, publishProject } from './factories.js';
import { projects, projectVersions } from '../src/db/schema/registry.js';

describe('auth schema', () => {
  it('matches Better Auth’s own table specification', () => {
    const expected = getSchema(
      buildAuthOptions({
        config: { ...config(), features: { ...config().features, testDefinitions: true, resultSubmission: true } },
      }),
    );
    expect(Object.keys(expected).sort()).toEqual([...AUTH_MODELS].sort());

    for (const [model, table] of Object.entries(expected)) {
      const drizzleTable = (AUTH_SCHEMA as Record<string, Record<string, unknown>>)[model];
      expect(drizzleTable, `missing drizzle table for ${model}`).toBeDefined();
      for (const [field, attributes] of Object.entries(table.fields)) {
        const column = attributes.fieldName ?? field;
        expect(
          Object.hasOwn(drizzleTable as object, column),
          `generated schema is stale: ${model}.${column} is missing. Run \`pnpm db:auth-schema\`.`,
        ).toBe(true);
      }
    }
  });

  it('has every auth table present in the migrated database', async () => {
    const result = await db().execute<{ table_name: string }>(sql`
      select table_name from information_schema.tables where table_schema = 'public'
    `);
    const present = new Set(
      ((result.rows ?? result) as Array<{ table_name: string }>).map((row) => row.table_name),
    );
    for (const expected of ['user', 'session', 'account', 'jwks', 'oauth_client', 'oauth_access_token']) {
      expect(present.has(expected)).toBe(true);
    }
  });
});

describe('ownership and integrity constraints', () => {
  it('refuses a current-version pointer from another project', async () => {
    const accountA = await createAccount();
    const accountB = await createAccount();
    const a = await publishProject(accountA, projectDocument({ key: 'owner-a' }));
    const b = await publishProject(accountB, projectDocument({ key: 'owner-b' }));

    await expect(
      db()
        .update(projects)
        .set({ currentVersionId: b.projectVersionId })
        .where(sql`${projects.id} = ${a.projectId}`),
    ).rejects.toThrow();
  });

  it('refuses two versions with the same number or identical content', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'constraint' }));
    const [version] = await db()
      .select()
      .from(projectVersions)
      .where(sql`${projectVersions.id} = ${published.projectVersionId}`);

    await expect(
      db().insert(projectVersions).values({
        projectId: published.projectId,
        versionNumber: 1,
        specVersion: '0.2.0',
        schemaId: version!.schemaId,
        manifest: version!.manifest,
        markdown: version!.markdown,
        contentDigest: `sha256:${'c'.repeat(64)}`,
        payloadDigest: `sha256:${'d'.repeat(64)}`,
        derived: version!.derived,
        publishedByUserId: account.userId,
      }),
    ).rejects.toThrow();

    await expect(
      db().insert(projectVersions).values({
        projectId: published.projectId,
        versionNumber: 2,
        specVersion: '0.2.0',
        schemaId: version!.schemaId,
        manifest: version!.manifest,
        markdown: version!.markdown,
        contentDigest: version!.contentDigest,
        payloadDigest: `sha256:${'e'.repeat(64)}`,
        derived: version!.derived,
        publishedByUserId: account.userId,
      }),
    ).rejects.toThrow();
  });

  it('refuses a malformed content digest', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'digest-format' }));
    const [version] = await db()
      .select()
      .from(projectVersions)
      .where(sql`${projectVersions.id} = ${published.projectVersionId}`);
    await expect(
      db().insert(projectVersions).values({
        projectId: published.projectId,
        versionNumber: 2,
        specVersion: '0.2.0',
        schemaId: version!.schemaId,
        manifest: version!.manifest,
        markdown: version!.markdown,
        contentDigest: 'not-a-digest',
        payloadDigest: `sha256:${'f'.repeat(64)}`,
        derived: version!.derived,
        publishedByUserId: account.userId,
      }),
    ).rejects.toThrow();
  });

  it('refuses a published project with no current version', async () => {
    await expect(
      db().execute(sql`
        insert into projects (slug, project_key, manager_user_id, type, visibility, listing_origin)
        values ('orphan', 'orphan', 'does-not-exist', 'documentation', 'published', 'creator_submitted')
      `),
    ).rejects.toThrow();
  });

  it('keeps one live approval per draft', async () => {
    const account = await createAccount();
    const published = await publishProject(account, projectDocument({ key: 'one-approval' }));
    const inserted = await db().execute<{ count: string }>(sql`
      select count(*)::text as count from publication_approvals
      where draft_id = ${published.draftId} and consumed_at is not null
    `);
    expect(Number(((inserted.rows ?? inserted)[0] as { count: string }).count)).toBe(1);
  });
});
