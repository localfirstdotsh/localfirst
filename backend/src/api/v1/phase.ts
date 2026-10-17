/** Executable setup, arbitrary/custom harnesses and multi-agent execution remain gated. */
import { Hono } from 'hono';
import type { AppEnv } from '../../http/context.js';
export const laterPhaseRoutes = new Hono<AppEnv>();
export const LATER_PHASE_PATHS: string[] = [];
