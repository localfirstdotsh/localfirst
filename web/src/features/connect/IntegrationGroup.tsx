/** Local vendor marks identify MCP compatibility, not endorsement; see asset licenses. */
import { AI_INTEGRATIONS } from '../../lib/capabilities';

export function IntegrationGroup() {
  return (
    <section aria-labelledby="integrations">
      <h2 className="eyebrow" id="integrations">WORKS WITH AI TOOLS</h2>
      <ul className="integration-list">
        {AI_INTEGRATIONS.map((client) => (
          <li key={client.id}>
            <a href={`/docs/connect#${client.id}`}>
              {/* Small, local vector marks need no image optimization. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={`/integrations/${client.icon}.svg`} width="26" height="26" alt="" />
              {client.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="integration-note">Connect over MCP. Choose your client for setup instructions.</p>
    </section>
  );
}
