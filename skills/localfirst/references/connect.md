# Connect an agent to the registry

The hosted MCP server is `POST {registry}/mcp`, a stateless streamable-HTTP profile. `GET` and
`DELETE` return 405, so a client that insists on a session needs the REST API (`{registry}/api/v1`)
instead.

## Authentication

- OAuth with PKCE. The access token's audience is the MCP resource and is refused at REST; a REST
  token is refused at MCP. Do not reuse one for the other.
- A client needs `projects:read` to read. Authoring and publishing need the scopes listed in
  `references/publish.md`. A scope error carries an `insufficient_scope` challenge; request only
  what the operation needs.
- Dynamic client registration is a deployment setting and may be off. If the client cannot
  register itself, the user must supply registered client details.

## Clients

Tested clients and what each result actually proves are recorded in
[backend/docs/CLIENT_MATRIX.md](../../../backend/docs/CLIENT_MATRIX.md). A client not listed there
is untested; say so rather than claiming it works.

`localfirstdotsh mcp add` is not available yet. Configure the client with its own MCP command, using
the registry's `/mcp` URL and the client's HTTP transport.
