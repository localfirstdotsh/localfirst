import { MCP_TOOL_CATALOG, type McpToolAccess } from '@localfirst/contracts';

const GROUPS: ReadonlyArray<{ access: McpToolAccess; heading: string; note: string }> = [
  { access: 'read', heading: 'Read only', note: 'Look things up. These change nothing.' },
  { access: 'save', heading: 'Save privately', note: 'Write drafts, builds, reports, or notes that only you can see until you publish.' },
  { access: 'publish', heading: 'Publish', note: 'Make a draft public. You approve that exact version in your browser first; the agent cannot approve it for you.' },
];

/** What a connected AI client can do, from the same list a backend test checks against the live server. */
export function McpToolTable() {
  return (
    <div className="stack gap-16">
      {GROUPS.map((group) => (
        <div key={group.access} className="stack gap-8">
          <h3>{group.heading}</h3>
          <p className="muted">{group.note}</p>
          <ul className="stack gap-4">
            {MCP_TOOL_CATALOG.filter((tool) => tool.access === group.access).map((tool) => (
              <li key={tool.name}><code>{tool.name}</code> — {tool.title}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
