import type { z } from 'zod';
import { siteUrl } from './site';
import { emptyQuery, toApiSearchParams, type CatalogQuery } from './catalog-query';
import { visitorIp } from './client-ip';
import {
  assessmentSchema,
  errorEnvelopeSchema,
  facetsSchema,
  hardwareListSchema,
  modelListSchema,
  projectDetailSchema,
  projectPageSchema,
  slugResolutionSchema,
  successEnvelope,
  versionDetailSchema,
  versionListSchema,
  type Assessment,
  type Facets,
  type HardwareReference,
  type ModelReference,
  type ProjectDetail,
  type ProjectPage,
  type VersionDetail,
  type VersionList,
} from './schemas';

/** The registry API could not be reached (network, timeout, 5xx). */
export class ApiUnavailableError extends Error {
  constructor(
    message: string,
    readonly requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiUnavailableError';
  }
}

/** The API answered with a domain error. */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** The API answered successfully with a shape this website does not understand. */
export class ApiContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiContractError';
  }
}

function originOf(raw: string, name: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    throw new Error(`${name} must be an absolute URL.`);
  }
}

/**
 * Where this server calls the registry. In production this is the private-network address, so
 * the hop is trusted by the API and the visitor's forwarded address can be believed
 * (see lib/client-ip.ts). A browser cannot reach a private address; see publicApiUrl().
 */
export function apiBaseUrl(): string {
  return originOf(process.env.LOCALFIRST_API_URL ?? 'http://localhost:8787', 'LOCALFIRST_API_URL');
}

/**
 * The registry address browsers are sent to: sign-in, the privacy page, and export downloads.
 * Defaults to the website origin; runtime route handlers proxy to the private API.
 */
export function publicApiUrl(): string {
  const raw = process.env.LOCALFIRST_PUBLIC_API_URL;
  return raw ? originOf(raw, 'LOCALFIRST_PUBLIC_API_URL') : siteUrl();
}

const TIMEOUT_MS = 8_000;

interface RequestOptions {
  /** Seconds of public-cache freshness. Public reads only; never private data. */
  revalidate: number;
  /** A JSON POST is never cached. */
  post?: unknown;
}

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  options: RequestOptions,
): Promise<z.infer<S>> {
  // The visitor's address, when the deployment forwards it, so the API's per-client limits apply
  // to each visitor and not to this server (see lib/client-ip.ts).
  const visitor = await visitorIp();
  const forwarded: Record<string, string> = visitor ? { 'x-forwarded-for': visitor } : {};

  let response: Response;
  try {
    const init: RequestInit & { next?: { revalidate: number } } =
      options.post === undefined
        ? { headers: { accept: 'application/json', ...forwarded }, next: { revalidate: options.revalidate } }
        : {
            method: 'POST',
            headers: { accept: 'application/json', 'content-type': 'application/json', ...forwarded },
            body: JSON.stringify(options.post),
            cache: 'no-store',
          };
    response = await fetch(`${apiBaseUrl()}${path}`, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new ApiUnavailableError('The registry could not be reached.');
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok) {
    const parsed = errorEnvelopeSchema.safeParse(body);
    if (parsed.success) {
      if (response.status >= 500) {
        throw new ApiUnavailableError(parsed.data.error.message, parsed.data.meta.request_id);
      }
      throw new ApiRequestError(
        parsed.data.error.message,
        response.status,
        parsed.data.error.code,
        parsed.data.meta.request_id,
      );
    }
    if (response.status >= 500) throw new ApiUnavailableError('The registry is unavailable.');
    throw new ApiRequestError('The request was not accepted.', response.status, 'UNKNOWN', null);
  }

  const parsed = successEnvelope(schema).safeParse(body);
  if (!parsed.success) throw new ApiContractError('The registry returned an unexpected response.');
  // `parsed` was validated against the envelope schema above; this only recovers the generic type.
  return (parsed.data as { data: z.infer<S> }).data;
}

const LIST_FRESHNESS_SECONDS = 60;

export function listProjects(query: CatalogQuery, limit?: number): Promise<ProjectPage> {
  const params = toApiSearchParams(query, limit);
  const qs = params.toString();
  return request(`/api/v1/projects${qs ? `?${qs}` : ''}`, projectPageSchema, {
    revalidate: LIST_FRESHNESS_SECONDS,
  });
}

export function getFacets(): Promise<Facets> {
  return request('/api/v1/catalog/facets', facetsSchema, { revalidate: LIST_FRESHNESS_SECONDS });
}

/** Resolve a public slug, then read the authoritative detail by ID. Missing and hidden both 404. */
export async function getProjectBySlug(slug: string): Promise<ProjectDetail> {
  const resolved = await request(
    `/api/v1/projects/by-slug/${encodeURIComponent(slug)}`,
    slugResolutionSchema,
    { revalidate: LIST_FRESHNESS_SECONDS },
  );
  return request(`/api/v1/projects/${encodeURIComponent(resolved.project_id)}`, projectDetailSchema, {
    revalidate: LIST_FRESHNESS_SECONDS,
  });
}

export function listVersions(projectId: string): Promise<VersionList> {
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/versions`, versionListSchema, {
    revalidate: LIST_FRESHNESS_SECONDS,
  });
}

/** An exact immutable version. Its content never changes, so it can be cached longer. */
export function getVersion(projectId: string, versionId: string): Promise<VersionDetail> {
  return request(
    `/api/v1/projects/${encodeURIComponent(projectId)}/versions/${encodeURIComponent(versionId)}`,
    versionDetailSchema,
    { revalidate: 300 },
  );
}

export function checkCompatibility(projectId: string, body: unknown): Promise<Assessment> {
  return request(`/api/v1/projects/${encodeURIComponent(projectId)}/compatibility-checks`, assessmentSchema, {
    revalidate: 0,
    post: body,
  });
}

/** The API returns at most this many references and no cursor; a full list may be truncated. */
export const REFERENCE_LIST_LIMIT = 100;

export async function listModels(): Promise<ModelReference[]> {
  return (await request('/api/v1/models', modelListSchema, { revalidate: LIST_FRESHNESS_SECONDS })).items;
}

export async function listHardware(): Promise<HardwareReference[]> {
  return (await request('/api/v1/hardware', hardwareListSchema, { revalidate: LIST_FRESHNESS_SECONDS })).items;
}

/** Every visible project, for the sitemap. Bounded so a huge registry cannot stall a request. */
export async function listAllProjects(maxPages = 50): Promise<ProjectPage['items']> {
  const items: ProjectPage['items'] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page += 1) {
    const query: CatalogQuery = { ...emptyQuery(), cursor };
    const result: ProjectPage = await listProjects(query, 100);
    items.push(...result.items);
    if (!result.has_more || !result.next_cursor) break;
    cursor = result.next_cursor;
  }
  return items;
}
