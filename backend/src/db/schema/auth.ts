/**
 * GENERATED FILE — do not edit by hand.
 *
 * Mirrors Better Auth's own table specification for the configured plugins
 * (GitHub sign-in, JWT signing keys, and the MCP/OAuth provider). Regenerate
 * with `pnpm db:auth-schema` after an auth dependency or plugin change, then
 * review the generated SQL migration.
 *
 * Generated from: better-auth pinned release
 */

import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const userTable = pgTable(
  'user',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull().unique(),
    emailVerified: boolean('emailVerified').notNull(),
    image: text('image'),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull(),
  },
);

export const sessionTable = pgTable(
  'session',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
    token: text('token').notNull().unique(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull(),
    ipAddress: text('ipAddress'),
    userAgent: text('userAgent'),
    userId: text('userId').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
  },
);

export const accountTable = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    accountId: text('accountId').notNull(),
    providerId: text('providerId').notNull(),
    userId: text('userId').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    accessToken: text('accessToken'),
    refreshToken: text('refreshToken'),
    idToken: text('idToken'),
    accessTokenExpiresAt: timestamp('accessTokenExpiresAt', { withTimezone: true, mode: 'date' }),
    refreshTokenExpiresAt: timestamp('refreshTokenExpiresAt', { withTimezone: true, mode: 'date' }),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull(),
  },
);

export const verificationTable = pgTable(
  'verification',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull(),
  },
);

export const jwksTable = pgTable(
  'jwks',
  {
    id: text('id').primaryKey(),
    publicKey: text('publicKey').notNull(),
    privateKey: text('privateKey').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }),
    alg: text('alg'),
    crv: text('crv'),
  },
);

export const oauthClientTable = pgTable(
  'oauth_client',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().unique(),
    clientSecret: text('clientSecret'),
    clientDiscoveryId: text('clientDiscoveryId'),
    disabled: boolean('disabled'),
    skipConsent: boolean('skipConsent'),
    enableEndSession: boolean('enableEndSession'),
    subjectType: text('subjectType'),
    scopes: jsonb('scopes'),
    clientCredentialsScopes: jsonb('clientCredentialsScopes'),
    userId: text('userId').references(() => userTable.id, { onDelete: 'cascade' }),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }),
    name: text('name'),
    uri: text('uri'),
    icon: text('icon'),
    contacts: jsonb('contacts'),
    tos: text('tos'),
    policy: text('policy'),
    softwareId: text('softwareId'),
    softwareVersion: text('softwareVersion'),
    softwareStatement: text('softwareStatement'),
    redirectUris: jsonb('redirectUris').notNull(),
    postLogoutRedirectUris: jsonb('postLogoutRedirectUris'),
    backchannelLogoutUri: text('backchannelLogoutUri'),
    backchannelLogoutSessionRequired: boolean('backchannelLogoutSessionRequired'),
    tokenEndpointAuthMethod: text('tokenEndpointAuthMethod'),
    applicationType: text('applicationType'),
    jwks: text('jwks'),
    jwksUri: text('jwksUri'),
    grantTypes: jsonb('grantTypes'),
    responseTypes: jsonb('responseTypes'),
    requirePKCE: boolean('requirePKCE'),
    dpopBoundAccessTokens: boolean('dpopBoundAccessTokens'),
    referenceId: text('referenceId'),
    metadata: jsonb('metadata'),
  },
);

export const oauthResourceTable = pgTable(
  'oauth_resource',
  {
    id: text('id').primaryKey(),
    identifier: text('identifier').notNull().unique(),
    name: text('name').notNull(),
    accessTokenTtl: integer('accessTokenTtl'),
    refreshTokenTtl: integer('refreshTokenTtl'),
    signingAlgorithm: text('signingAlgorithm'),
    signingKeyId: text('signingKeyId'),
    allowedScopes: jsonb('allowedScopes'),
    customClaims: jsonb('customClaims'),
    dpopBoundAccessTokensRequired: boolean('dpopBoundAccessTokensRequired'),
    disabled: boolean('disabled'),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }),
    policyVersion: integer('policyVersion'),
    metadata: jsonb('metadata'),
  },
);

export const oauthClientResourceTable = pgTable(
  'oauth_client_resource',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().references(() => oauthClientTable.clientId, { onDelete: 'cascade' }),
    resourceId: text('resourceId').notNull().references(() => oauthResourceTable.identifier, { onDelete: 'cascade' }),
    metadata: jsonb('metadata'),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }),
  },
  (columns) => [
    uniqueIndex('oauthClientResource_clientId_resourceId_uidx').on(columns.clientId, columns.resourceId),
  ],
);

export const oauthRefreshTokenTable = pgTable(
  'oauth_refresh_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId').notNull().references(() => oauthClientTable.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => sessionTable.id, { onDelete: 'set null' }),
    userId: text('userId').notNull().references(() => userTable.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: jsonb('resources'),
    requestedUserInfoClaims: jsonb('requestedUserInfoClaims'),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true, mode: 'date' }),
    rotatedAt: timestamp('rotatedAt', { withTimezone: true, mode: 'date' }),
    rotationReplayResponse: text('rotationReplayResponse'),
    rotationReplayExpiresAt: timestamp('rotationReplayExpiresAt', { withTimezone: true, mode: 'date' }),
    authTime: timestamp('authTime', { withTimezone: true, mode: 'date' }),
    confirmation: jsonb('confirmation'),
    scopes: jsonb('scopes').notNull(),
  },
);

export const oauthAccessTokenTable = pgTable(
  'oauth_access_token',
  {
    id: text('id').primaryKey(),
    token: text('token').notNull().unique(),
    clientId: text('clientId').notNull().references(() => oauthClientTable.clientId, { onDelete: 'cascade' }),
    sessionId: text('sessionId').references(() => sessionTable.id, { onDelete: 'set null' }),
    userId: text('userId').references(() => userTable.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    authorizationCodeId: text('authorizationCodeId'),
    resources: jsonb('resources'),
    requestedUserInfoClaims: jsonb('requestedUserInfoClaims'),
    refreshId: text('refreshId').references(() => oauthRefreshTokenTable.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    revoked: timestamp('revoked', { withTimezone: true, mode: 'date' }),
    confirmation: jsonb('confirmation'),
    scopes: jsonb('scopes').notNull(),
  },
);

export const oauthConsentTable = pgTable(
  'oauth_consent',
  {
    id: text('id').primaryKey(),
    clientId: text('clientId').notNull().references(() => oauthClientTable.clientId, { onDelete: 'cascade' }),
    userId: text('userId').references(() => userTable.id, { onDelete: 'cascade' }),
    referenceId: text('referenceId'),
    resources: jsonb('resources'),
    requestedUserInfoClaims: jsonb('requestedUserInfoClaims'),
    scopes: jsonb('scopes').notNull(),
    createdAt: timestamp('createdAt', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updatedAt', { withTimezone: true, mode: 'date' }).notNull(),
  },
);

export const oauthClientAssertionTable = pgTable(
  'oauth_client_assertion',
  {
    id: text('id').primaryKey(),
    expiresAt: timestamp('expiresAt', { withTimezone: true, mode: 'date' }).notNull(),
  },
);

/** Table names Better Auth owns, for schema-drift assertions in tests. */
export const AUTH_MODELS = ["user","session","account","verification","jwks","oauthClient","oauthResource","oauthClientResource","oauthRefreshToken","oauthAccessToken","oauthConsent","oauthClientAssertion"] as const;

/** Model-name keyed map handed to the Better Auth Drizzle adapter. */
export const AUTH_SCHEMA = {
  user: userTable,
  session: sessionTable,
  account: accountTable,
  verification: verificationTable,
  jwks: jwksTable,
  oauthClient: oauthClientTable,
  oauthResource: oauthResourceTable,
  oauthClientResource: oauthClientResourceTable,
  oauthRefreshToken: oauthRefreshTokenTable,
  oauthAccessToken: oauthAccessTokenTable,
  oauthConsent: oauthConsentTable,
  oauthClientAssertion: oauthClientAssertionTable,
} as const;
