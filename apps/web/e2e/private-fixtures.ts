import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, type APIRequestContext } from '@playwright/test';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML } from '@localfirst/contracts';
import c from './constants.json' with { type: 'json' };
import { API, OWNER_ID } from './helpers';

/** Only the runner's disposable database, never DATABASE_URL or application data. */
export async function fixtureQuery(sql: string, values: unknown[] = []) {
  const url = new URL(process.env.E2E_ADMIN_DATABASE_URL ?? 'postgres://localhost:5432/postgres');
  url.pathname = `/${c.database}`;
  const db = new pg.Client({ connectionString: url.href });
  await db.connect();
  try { return await db.query(sql, values); } finally { await db.end(); }
}
export async function createDraft(request: APIRequestContext) {
  const key = `browser-${randomUUID()}`;
  const markdown = EXAMPLE_PROJECT_MD.replace('key: request-labeler', `key: ${key}`);
  const testYaml = EXAMPLE_TEST_YAML.replace('project_key: request-labeler', `project_key: ${key}`);
  const response = await request.post(`${API}/api/v1/drafts`, { headers: { 'x-dev-user': OWNER_ID, 'idempotency-key': randomUUID() }, data: { kind: 'project', project_md: markdown, files: [{ path: EXAMPLE_TEST_PATH, content: testYaml }] } });
  expect(response.ok(), await response.text()).toBe(true);
  const draft = (await response.json()).data as { draft_id: string; revision: number; payload_digest: string; warning_codes: string[]; etag: string };
  return { ...draft, markdown };
}
export async function createDeletionAccount() {
  const id = `e2e-delete-${randomUUID()}`;
  await fixtureQuery('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, false, now(), now())', [id, `${id}@e2e.localfirst.invalid`]);
  await fixtureQuery('insert into user_profiles (user_id, handle, display_name, external_identities) values ($1, $1, $1, \'[]\'::jsonb)', [id]);
  return id;
}
