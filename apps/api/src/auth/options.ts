/**
 * Better Auth composition (BACKEND_PRD sections 10.1, 10.5, 10.6).
 *
 * The MCP plugin *is* the OAuth provider in Better Auth 1.7.x
 * (`@better-auth/mcp` builds on `@better-auth/oauth-provider`), so no second
 * provider owner is registered for the same endpoints. Tokens are audience
 * bound: the MCP resource and the REST resource are distinct audiences and a
 * token for one is not accepted at the other.
 */

import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import type { BetterAuthOptions } from 'better-auth/types';
import type { AppConfig } from '../config.js';
import { advertisedScopes, PRODUCT_SCOPES } from './scopes.js';
import { CLIENT_IP_HEADER } from '../http/client-ip.js';
import { ensureProfile, rememberGithubLogin } from './profiles.js';

export interface AuthOptionsInput {
  config: AppConfig;
  /** Omitted only by the schema generator, which inspects options statically. */
  database?: BetterAuthOptions['database'];
}

export function buildAuthOptions({ config, database }: AuthOptionsInput): BetterAuthOptions {
  const scopes = advertisedScopes(config).map((scope) => ({
    scope,
    description: PRODUCT_SCOPES[scope].description,
  }));

  const options: BetterAuthOptions = {
    appName: 'Localfirst',
    baseURL: config.apiBaseUrl,
    basePath: config.authBasePath,
    secret: config.authSecret,
    trustedOrigins: config.trustedOrigins,
    telemetry: { enabled: false },
    advanced: {
      // Only the address the app resolved behind trusted proxies (app.ts).
      ipAddress: { ipAddressHeaders: [CLIENT_IP_HEADER] },
      // Production cookies are secure + HttpOnly with SameSite protection.
      useSecureCookies: config.isProduction,
      defaultCookieAttributes: {
        sameSite: 'lax',
        httpOnly: true,
        path: '/',
      },
    },
    session: {
      expiresIn: config.ttl.sessionSeconds,
      updateAge: Math.min(config.ttl.sessionSeconds, 24 * 3600),
    },
    rateLimit: { enabled: true, window: 60, max: 120 },
    emailAndPassword: { enabled: false },
    // Every person who signs in gets a Localfirst profile (src/auth/profiles.ts):
    // the GitHub login seen at sign-in becomes the handle, and the session hook
    // creates the profile once the user row exists.
    user: {
      validateUserInfo: ({ user, source }) => {
        if (source.method === 'oauth' && source.oauth?.providerId === 'github') {
          rememberGithubLogin(typeof user.email === 'string' ? user.email : null, source.oauth.profile);
        }
      },
    },
    databaseHooks: {
      session: {
        create: {
          after: async (session) => {
            await ensureProfile(session.userId);
          },
        },
      },
    },
    // GitHub human sign-in. Minimum identity/email access only: no repository
    // permissions are needed to publish registry metadata (section 10.5).
    socialProviders:
      config.github.clientId && config.github.clientSecret
        ? {
            github: {
              clientId: config.github.clientId,
              clientSecret: config.github.clientSecret,
              scope: ['read:user', 'user:email'],
            },
          }
        : {},
    plugins: [
      jwt({ jwt: { issuer: config.authIssuer, audience: config.apiBaseUrl } }),
      mcp({
        loginPage: `${config.websiteUrl}/sign-in`,
        consentPage: `${config.websiteUrl}/consent`,
        // Canonical MCP protected-resource identifier (RFC 8707/9728).
        resource: config.mcpResource,
        // The REST adapter is a second protected resource with its own audience.
        resources: [
          {
            identifier: config.restResource,
            name: 'Localfirst REST API',
            allowedScopes: scopes.map((entry) => entry.scope),
            accessTokenTtl: config.ttl.accessTokenSeconds,
          },
        ],
        enforcePerClientResources: false,
        scopes: scopes.map((entry) => entry.scope),
        accessTokenExpiresIn: config.ttl.accessTokenSeconds,
        refreshTokenExpiresIn: config.ttl.refreshTokenSeconds,
        codeExpiresIn: config.ttl.authorizationCodeSeconds,
        // Dynamic registration stays off unless enabled. When on, an MCP
        // application registers itself without a session, as a public PKCE
        // client with no secret, which is how Claude Code and other MCP
        // clients connect. Scopes stay limited to the product list, the default
        // grant is read-only, and every grant still needs the person's consent.
        allowDynamicClientRegistration: config.features.dynamicClientRegistration,
        allowUnauthenticatedClientRegistration: config.features.dynamicClientRegistration,
        clientRegistrationRequirePKCE: true,
        clientRegistrationAllowedScopes: scopes.map((entry) => entry.scope),
        clientRegistrationDefaultScopes: ['projects:read'],
        storeClientSecret: 'hashed',
        storeTokens: 'hashed',
      }),
    ],
  };
  if (database) options.database = database;
  return options;
}
