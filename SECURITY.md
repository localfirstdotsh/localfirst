# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private
vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Include what you found, how to reproduce it, and the
version or commit.

You can expect an acknowledgement, and we will tell you what we decide to do. Please
give us reasonable time to fix a problem before you disclose it.

## Scope

- The registry backend, website, and the `localfirstdotsh` command-line tool in this repository.
- The OAuth sign-in, consent, and approval flows, and the MCP server.

Examples we care about: a way to publish without the person's approval of the exact
version, a way to make the command-line tool run something the person did not approve,
leaked credentials, and bypassing the consent screen.

## What the command-line tool does not do

It has no telemetry, update checks, or background service, and it never accepts a
`--yes` flag for approvals. If you find behavior that contradicts this, that is a bug
we want to hear about.
