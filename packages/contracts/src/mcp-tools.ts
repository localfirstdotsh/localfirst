/**
 * The tools the registry's MCP server advertises, for people reading what an
 * AI client can do. `apps/api/test/mcp.test.ts` fails if this list and the
 * server's `tools/list` disagree, so it cannot drift silently.
 *
 * `read` tools change nothing; `save` tools write private drafts, builds,
 * reports or notes that nobody else sees; `publish` makes a draft public and
 * only after the person approves that exact version in their browser.
 */
export type McpToolAccess = 'read' | 'save' | 'publish';

export interface McpToolEntry {
  readonly name: string;
  readonly title: string;
  readonly access: McpToolAccess;
}

export const MCP_TOOL_CATALOG: readonly McpToolEntry[] = [
  { name: 'project_search', title: 'Search local-AI projects', access: 'read' },
  { name: 'project_get', title: 'Get a project specification', access: 'read' },
  { name: 'project_check_compatibility', title: 'Assess declared compatibility', access: 'read' },
  { name: 'project_get_derivatives', title: 'Read attributed lineage', access: 'read' },
  { name: 'reference_get_relationships', title: 'Read model or hardware relationships', access: 'read' },
  { name: 'comparison_get_groups', title: 'Compare accepted public reports', access: 'read' },
  { name: 'community_list', title: 'Read curated community knowledge', access: 'read' },
  { name: 'test_get', title: 'Get a test definition', access: 'read' },
  { name: 'test_plan_local', title: 'Get a generic local test plan', access: 'read' },
  { name: 'test_get_result', title: 'Get a test result', access: 'read' },
  { name: 'test_get_verifications', title: 'Read independent verification provenance', access: 'read' },
  { name: 'build_get', title: 'Get a build', access: 'read' },
  { name: 'build_get_evidence', title: 'Get accepted evidence', access: 'read' },
  { name: 'draft_get', title: 'Get your draft', access: 'read' },
  { name: 'contribution_create_draft', title: 'Create a contribution draft', access: 'save' },
  { name: 'project_create_derivative_draft', title: 'Create an attributed derivative draft', access: 'save' },
  { name: 'draft_update', title: 'Update your draft', access: 'save' },
  { name: 'draft_validate', title: 'Validate your draft', access: 'save' },
  { name: 'build_save', title: 'Save a private build', access: 'save' },
  { name: 'test_submit_result', title: 'Submit a sanitized test result', access: 'save' },
  { name: 'community_save', title: 'Save a private community contribution', access: 'save' },
  { name: 'contribution_publish', title: 'Publish an approved contribution', access: 'publish' },
];
