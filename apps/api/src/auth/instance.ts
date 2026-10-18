/**
 * The Better Auth instance (BACKEND_PRD section 10.6).
 *
 * Protocol endpoints under the auth base path are owned by this instance; the
 * domain REST envelope is not applied to them.
 */

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { db } from '../db/client.js';
import { AUTH_SCHEMA } from '../db/schema/auth.js';
import { config } from '../config.js';
import { buildAuthOptions } from './options.js';

export type Auth = ReturnType<typeof betterAuth>;

let instance: Auth | null = null;

export function auth(): Auth {
  instance ??= betterAuth(
    buildAuthOptions({
      config: config(),
      database: drizzleAdapter(db(), {
        provider: 'pg',
        schema: AUTH_SCHEMA,
        usePlural: false,
        transaction: true,
      }),
    }),
  );
  return instance;
}

export function resetAuth(): void {
  instance = null;
}
