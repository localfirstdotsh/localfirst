import { mcpConfig, type ConfigClient } from '../../lib/mcp-setup';
import { CopyBlock } from '../../components/composites/CopyBlock';
import { StatePanel } from '../../components/composites/StatePanel';

/** One config/copy/failure presentation for all documented native client formats. */
export function McpConfigBlock({ client, endpoint }: { client: ConfigClient; endpoint: string | null }) {
  if (!endpoint) {
    return <StatePanel title="Connection configuration unavailable" level="h3">
      The registry’s MCP endpoint could not be discovered. <a href={`/docs/connect#${client}`}>Try again</a> or consult your registry operator.
    </StatePanel>;
  }
  return <CopyBlock text={mcpConfig(client, endpoint)} format="json" note="Configuration only. Merge the localfirst entry into your existing settings; copying does not edit files, grant access, or run tools." />;
}
