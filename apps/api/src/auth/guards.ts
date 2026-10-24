/**
 * Access guards (BACKEND_PRD section 12 access column).
 *
 * **Public** reads published safe content. **Session/token** needs a human
 * session or a correct REST-audience bearer with the listed scope plus
 * ownership. **Human** is session only. **Operator** needs an administratively
 * assigned role.
 */

import type { MiddlewareHandler } from 'hono';
import { ApiError } from '../http/errors.js';
import type { AppEnv, OperatorRole } from '../http/context.js';
import { isOperator } from '../http/context.js';
import { restChallenge } from './actor.js';
import type { ProductScope } from './scopes.js';

export function requireAuthenticated(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('actor').kind === 'anonymous') {
      throw ApiError.unauthenticated(
        'Sign in or present a Localfirst access token.',
        restChallenge(),
      );
    }
    await next();
  };
}

/** Any one of the listed scopes is enough. */
export function requireScope(...scopes: ProductScope[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor.kind === 'anonymous') {
      throw ApiError.unauthenticated(
        'Sign in or present a Localfirst access token.',
        restChallenge({ scopes }),
      );
    }
    if (!scopes.some((scope) => actor.scopes.has(scope))) {
      throw ApiError.insufficientScope(
        scopes,
        restChallenge({ error: 'insufficient_scope', scopes }),
      );
    }
    await next();
  };
}

/**
 * Human-only routes. An agent token cannot stand in for a person here: this is
 * the boundary that makes exact-artifact approval meaningful (section 10.4).
 */
export function requireHuman(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor.kind === 'anonymous') {
      throw ApiError.unauthenticated('This action requires a signed-in person.');
    }
    if (actor.kind !== 'session') {
      throw ApiError.forbidden(
        'This action requires a signed-in person in a browser session, not an access token.',
      );
    }
    await next();
  };
}

export function requireOperator(role: OperatorRole = 'moderator'): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const actor = c.get('actor');
    if (actor.kind === 'anonymous') {
      throw ApiError.unauthenticated('This action requires an operator session.');
    }
    // Operator routes are not discoverable to non-operators.
    if (!isOperator(actor, role)) throw ApiError.notFound();
    await next();
  };
}
