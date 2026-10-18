/**
 * Product scopes (BACKEND_PRD section 10.2).
 *
 * Read scopes never grant execution. There is no hosted `runtime:execute` or
 * arbitrary-code scope. Only implemented phase scopes are advertised, and a
 * request should ask for the minimum needed operation.
 */

import type { AppConfig } from '../config.js';

export const PRODUCT_SCOPES = {
  'community:write': { phase: 'P2', description: 'Save and draft your own collections and attributed troubleshooting notes.' },
  'community:publish': { phase: 'P2', description: 'Publish a community contribution you separately approved.' },
  'projects:read': {
    phase: 'P0',
    description: 'Read the public registry catalog, specifications, and compatibility assessments.',
  },
  'projects:draft': {
    phase: 'P0',
    description: 'Create, edit, validate, and export your own project drafts.',
  },
  'projects:publish': {
    phase: 'P0',
    description: 'Publish your own project artifact that you separately approved as a human.',
  },
  'projects:update': {
    phase: 'P0',
    description: 'Create version updates and change visibility for projects you manage.',
  },
  'profile:read': {
    phase: 'P0',
    description: 'Read your minimal Localfirst identity and account state.',
  },
  'builds:write': {
    phase: 'P1',
    description: 'Save and read your own private build configurations.',
  },
  'builds:publish': {
    phase: 'P1',
    description: 'Publish a build contribution you approved.',
  },
  'tests:submit': {
    phase: 'P1',
    description: 'Upload and read your own sanitized local test reports.',
  },
  'tests:publish': {
    phase: 'P1',
    description: 'Publish a sanitized test report you approved.',
  },
} as const;

export type ProductScope = keyof typeof PRODUCT_SCOPES;

/** Protocol scopes are not product permissions (section 10.2). */
export const PROTOCOL_SCOPES = ['openid', 'profile', 'email', 'offline_access'] as const;

export const P0_SCOPES: ProductScope[] = [
  'projects:read',
  'projects:draft',
  'projects:publish',
  'projects:update',
  'profile:read',
];

export const P1_SCOPES: ProductScope[] = [
  'builds:write',
  'builds:publish',
  'tests:submit',
  'tests:publish',
];

/** Scopes this deployment advertises: implemented phases only. */
export function advertisedScopes(config: AppConfig): ProductScope[] {
  const scopes = [...P0_SCOPES];
  if (config.features.communityNetwork) scopes.push('community:write', 'community:publish');
  if (config.features.resultSubmission) scopes.push('tests:submit', 'tests:publish');
  if (config.features.resultSubmission || config.features.testDefinitions) {
    scopes.push('builds:write', 'builds:publish');
  }
  return [...new Set(scopes)];
}

export function isProductScope(value: string): value is ProductScope {
  return Object.hasOwn(PRODUCT_SCOPES, value);
}

export function parseScopeClaim(claim: unknown): Set<string> {
  if (typeof claim === 'string') {
    return new Set(claim.split(/\s+/).filter((value) => value.length > 0));
  }
  if (Array.isArray(claim)) {
    return new Set(claim.filter((value): value is string => typeof value === 'string'));
  }
  return new Set();
}
