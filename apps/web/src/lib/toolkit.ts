/**
 * The agent toolkit preview (`/docs/toolkit`). It shows what the `localfirst` agent skill
 * (`skills/localfirst`) will look like on the site before it is released, so it renders only when a
 * deployment turns it on (or in `next dev`). Docs links it only in preview mode; it stays out of the sitemap.
 * FRONTEND_PRD section 4.2: a proposed command is labelled as proposed, never as a working one.
 *
 * LOCALFIRST_TOOLKIT_PREVIEW=true
 */
export function toolkitPreviewEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOCALFIRST_TOOLKIT_PREVIEW === 'true' || env.NODE_ENV === 'development';
}

/** Proposed install command: the skill is in the repository but not yet installable from a release. */
export const TOOLKIT_INSTALL_COMMAND = 'npx skills add localfirstdotsh/localfirst';

export interface ToolkitTask {
  task: string;
  reference: 'discover' | 'publish' | 'local-testing' | 'connect';
  summary: string;
  surface: string;
}

/** One entry per file in `skills/localfirst/references`; a test keeps the two in step. */
export const TOOLKIT_TASKS: readonly ToolkitTask[] = [
  {
    task: 'Find a project and check fit',
    reference: 'discover',
    surface: 'Hosted MCP',
    summary: 'Search by model, runtime and hardware, read an exact version, and read the evidence level honestly.',
  },
  {
    task: 'Write and publish a project',
    reference: 'publish',
    surface: 'Hosted MCP + your approval',
    summary: 'Draft, validate against the live schema, then hand you the exact artifact to approve before publishing.',
  },
  {
    task: 'Run a test and share the result',
    reference: 'local-testing',
    surface: 'localfirstdotsh CLI',
    summary: 'Plan and run a bounded test on your machine after you approve it, then export and submit a sanitized report.',
  },
  {
    task: 'Connect an agent',
    reference: 'connect',
    surface: 'Hosted MCP',
    summary: 'Authentication, scopes and which clients have actually been tested.',
  },
];

export interface ToolkitBoundary {
  title: string;
  body: string;
}

export const TOOLKIT_BOUNDARIES: readonly ToolkitBoundary[] = [
  { title: 'You decide what gets published', body: 'You approve the exact revision and digest in your browser, or let one connection publish without asking from Connections. The skill cannot grant either.' },
  { title: 'Nothing runs on the registry', body: 'There is no hosted run or code tool. Tests run on your machine, after you approve the exact plan.' },
  { title: 'Claims stay claims', body: 'Unknown model, runtime, hardware and license facts are marked unknown. A declared claim is never presented as tested evidence.' },
  { title: 'Credentials stay local', body: 'Runtime and GitHub tokens are never registry tokens, and nothing private goes into a draft or report.' },
];
