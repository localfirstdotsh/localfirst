import { randomUUID } from 'node:crypto';
import { inArray } from 'drizzle-orm';
import { db, getPool } from '../db/client.js';
import { userTable } from '../db/schema/auth.js';
import { projects, projectVersions, userProfiles } from '../db/schema/registry.js';
import { runSeed } from '../seed/seed.js';

/** Bulk copies of validated seed shapes, including every version relation. */
export async function seedLoadFixture(count: number) {
  const seed = await runSeed();
  if (seed.skipped.length || !seed.published.length) throw new Error('Seed fixture validation failed');
  const originals = await db().select().from(projects).where(inArray(projects.id, seed.published.map((p) => p.project_id)));
  const versions = await db().select().from(projectVersions).where(inArray(projectVersions.id, originals.map((p) => p.currentVersionId!)));
  const templates = originals.map((project) => ({ project, version: versions.find((v) => v.id === project.currentVersionId)! }));
  const relations = ['project_version_files', 'project_version_tests', 'source_references', 'attributions',
    'project_version_model_roles', 'project_version_runtimes', 'project_version_hardware', 'search_documents'];
  const columnLists = new Map<string, string[]>();
  for (const table of relations) {
    const result = await getPool().query<{ column_name: string }>(
      'select column_name from information_schema.columns where table_schema = $1 and table_name = $2 order by ordinal_position', ['public', table]);
    columnLists.set(table, result.rows.map((c) => c.column_name));
  }
  for (let offset = templates.length; offset < count; offset += 200) {
    const copies = Array.from({ length: Math.min(200, count - offset) }, (_, i) => {
      const template = templates[(offset + i) % templates.length]!;
      return { ...template, id: randomUUID(), versionId: randomUUID(), userId: `verify-${randomUUID()}`, index: offset + i };
    });
    await db().transaction(async (tx) => {
      await tx.insert(userTable).values(copies.map((c) => ({ id: c.userId, name: `Verification ${c.index}`, email: `${c.userId}@verification.invalid`, emailVerified: false, createdAt: new Date(), updatedAt: new Date() })));
      await tx.insert(userProfiles).values(copies.map((c) => ({ userId: c.userId, handle: c.userId, displayName: `Verification ${c.index}` })));
      await tx.insert(projects).values(copies.map((c) => ({ ...c.project, id: c.id, managerUserId: c.userId, slug: `verification-${c.index}`, visibility: 'unpublished', currentVersionId: null })));
      await tx.insert(projectVersions).values(copies.map((c) => ({ ...c.version, id: c.versionId, projectId: c.id, publishedByUserId: c.userId, publishedFromDraftId: null, approvalId: null })));
    });
    // Relation copies use a single connection/transaction so all mappings remain atomic.
    const client = await getPool().connect();
    try {
      await client.query('begin');
      const mapping = JSON.stringify(copies.map((c) => ({ source: c.version.id, version: c.versionId, project: c.id, user: c.userId, slug: `verification-${c.index}` })));
      await client.query(`update projects p set current_version_id = m.version::uuid, visibility = 'published' from jsonb_to_recordset($1::jsonb) as m(project text, version text) where p.id = m.project::uuid`, [mapping]);
      for (const table of relations) {
        const columns = columnLists.get(table)!;
        const quoted = columns.map((c) => `"${c}"`).join(', ');
        const expressions = columns.map((c) => {
          if (c === 'id') return 'gen_random_uuid()';
          if (c === 'project_version_id') return 'm.version::uuid';
          if (c === 'project_id') return 'm.project::uuid';
          if (table === 'search_documents' && c === 'slug') return 'm.slug';
          if (table === 'attributions' && c === 'user_id') return "case when r.role = 'submitter' then m.\"user\" else r.user_id end";
          if (table === 'attributions' && c === 'name') return "case when r.role = 'submitter' then 'Verification submitter' else r.name end";
          return `r."${c}"`;
        }).join(', ');
        await client.query(`insert into "${table}" (${quoted}) select ${expressions} from "${table}" r join jsonb_to_recordset($1::jsonb) as m(source text, version text, project text, "user" text, slug text) on r.project_version_id = m.source::uuid`, [mapping]);
      }
      await client.query('commit');
    } catch (error) { await client.query('rollback'); throw error; }
    finally { client.release(); }
  }
  await getPool().query('analyze');
  return seed.published;
}
