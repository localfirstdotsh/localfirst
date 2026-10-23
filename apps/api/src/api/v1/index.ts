/**
 * REST adapter composition (BACKEND_PRD section 12).
 *
 * Every domain route resolves its caller against the REST resource audience:
 * an MCP-audience token is not accepted here, and a present-but-invalid bearer
 * token never falls back to a cookie.
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../http/context.js';
import { config } from '../../config.js';
import { resolveActor } from '../../auth/actor.js';
import { projectRoutes, hardwareProfileRoutes } from './projects.js';
import { draftRoutes, operationRoutes } from './drafts.js';
import { catalogRoutes } from './catalog.js';
import { meRoutes } from './me.js';
import { adminRoutes } from './admin.js';
import { communityRoutes } from './community.js';
import { laterPhaseRoutes } from './phase.js';
import {
  buildRoutes,
  projectEvidenceRoutes,
  testDefinitionRoutes,
  testResultRoutes,
} from './evidence.js';

export const v1Routes = new Hono<AppEnv>();

v1Routes.use('*', async (c, next) => {
  c.set(
    'actor',
    await resolveActor({ headers: c.req.raw.headers, audience: config().restResource }),
  );
  await next();
});

// Implemented Phase 1 surface.
v1Routes.route('/', communityRoutes);
v1Routes.route('/projects', projectRoutes);
v1Routes.route('/projects', projectEvidenceRoutes);
v1Routes.route('/test-definitions', testDefinitionRoutes);
v1Routes.route('/builds', buildRoutes);
v1Routes.route('/test-results', testResultRoutes);
v1Routes.route('/drafts', draftRoutes);
v1Routes.route('/operations', operationRoutes);
v1Routes.route('/hardware-profiles', hardwareProfileRoutes);
v1Routes.route('/me', meRoutes);
v1Routes.route('/admin', adminRoutes);
v1Routes.route('/', catalogRoutes);

// Documented but unimplemented phases, declared last so they never shadow a
// working route.
v1Routes.route('/', laterPhaseRoutes);
