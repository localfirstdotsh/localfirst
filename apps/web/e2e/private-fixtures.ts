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
/** A valid project draft with its bundled test. The headers choose who creates it: the owner's session by default. */
export async function createDraft(request: APIRequestContext, headers: Record<string, string> = { 'x-dev-user': OWNER_ID }) {
  const key = `browser-${randomUUID()}`;
  const markdown = EXAMPLE_PROJECT_MD.replace('key: request-labeler', `key: ${key}`);
  const testYaml = EXAMPLE_TEST_YAML.replace('project_key: request-labeler', `project_key: ${key}`);
  const response = await request.post(`${API}/api/v1/drafts`, { headers: { ...headers, 'idempotency-key': randomUUID() }, data: { kind: 'project', project_md: markdown, files: [{ path: EXAMPLE_TEST_PATH, content: testYaml }] } });
  expect(response.ok(), await response.text()).toBe(true);
  const draft = (await response.json()).data as { draft_id: string; revision: number; payload_digest: string; warning_codes: string[]; etag: string };
  return { ...draft, markdown };
}
/** A fresh account, so a test's drafts do not count against the shared owner's hourly draft limit. */
export async function createAccount(prefix: string) {
  const id = `${prefix}-${randomUUID()}`;
  await fixtureQuery('insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, $1, $2, false, now(), now())', [id, `${id}@e2e.localfirst.invalid`]);
  await fixtureQuery('insert into user_profiles (user_id, handle, display_name, external_identities) values ($1, $1, $1, \'[]\'::jsonb)', [id]);
  return id;
}
/** A connection the account authorized, with the permissions an agent asks for, in the disposable database. */
export async function createConnection(userId: string, scopes = ['projects:read', 'projects:draft', 'projects:publish']) {
  const id = `connection-${randomUUID()}`;
  const name = `Browser fixture agent ${id.slice(-8)}`;
  await fixtureQuery('insert into oauth_client (id, "clientId", name, "redirectUris") values ($1, $1, $2, \'[]\'::jsonb)', [id, name]);
  await fixtureQuery('insert into oauth_consent (id, "clientId", "userId", scopes, "createdAt", "updatedAt") values ($1, $1, $2, $3::jsonb, now(), now())', [id, userId, JSON.stringify(scopes)]);
  return { clientId: id, connectionId: id, name };
}
/** The connection's own requests: an agent token for that client. */
export const agentHeaders = (userId: string, clientId: string) => ({ 'x-dev-user': userId, 'x-dev-actor': 'token', 'x-dev-client': clientId });
