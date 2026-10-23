/** Safe grant metadata shared by the API and the session-only account page. */
import { desc, eq } from 'drizzle-orm';
import { ApiError } from '../http/errors.js';
import { db } from '../db/client.js';
import { oauthClientTable, oauthConsentTable } from '../db/schema/auth.js';
import { delegationSummary } from './delegation.js';

export async function listConnections(userId: string) {
  const rows = await db()
    .select({
      connection_id: oauthConsentTable.id,
      client_id: oauthConsentTable.clientId,
      client_name: oauthClientTable.name,
      scopes: oauthConsentTable.scopes,
      created_at: oauthConsentTable.createdAt,
      updated_at: oauthConsentTable.updatedAt,
    })
    .from(oauthConsentTable)
    .leftJoin(
      oauthClientTable,
      eq(oauthClientTable.clientId, oauthConsentTable.clientId),
    )
    .where(eq(oauthConsentTable.userId, userId))
    .orderBy(desc(oauthConsentTable.createdAt))
    .limit(100);
  const delegation = await delegationSummary(userId);
  return rows.map((row) => {
    if (
      !Array.isArray(row.scopes) ||
      row.scopes.some((scope) => typeof scope !== 'string')
    )
      throw ApiError.internal('Connection permissions could not be read.');
    return {
      ...row,
      scopes: row.scopes as string[],
      client_name: row.client_name ?? null,
      client_name_is_unverified: true,
      granted: true,
      /** The owner lets this connection publish without per-artifact approval (section 10.4). */
      publication_delegated: delegation.delegatedConsents.has(row.connection_id),
      delegated_publications: delegation.publicationsByClient.get(row.client_id) ?? [],
      created_at: row.created_at?.toISOString() ?? null,
      updated_at: row.updated_at?.toISOString() ?? null,
    };
  });
}
