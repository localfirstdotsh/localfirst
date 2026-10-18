import { CopyBlock } from '../../components/composites/CopyBlock';
import { StatePanel } from '../../components/composites/StatePanel';

/** The discovered MCP server URL, for apps that take a URL in their settings rather than a file or command. */
export function McpUrlBlock({ client, endpoint }: { client: string; endpoint: string | null }) {
  if (!endpoint) {
    return <StatePanel title="Server URL unavailable">
      The registry’s MCP endpoint could not be discovered. <a href={`/docs/connect#${client}`}>Try again</a> or consult your registry operator.
    </StatePanel>;
  }
  return <CopyBlock text={endpoint} format="command" note="Server URL only. Copying does not add the connector, grant access, or run tools." />;
}
