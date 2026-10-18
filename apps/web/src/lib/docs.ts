/** Public guides shared by the docs index, navigation and sitemap. */
export const DOCS_GUIDES = [
  { href: '/docs/connect', title: 'Connect your agent', description: 'Add the registry to your AI client, review permissions, and troubleshoot the connection.' },
  { href: '/docs/project-spec', title: 'Project specification', description: 'Write a portable PROJECT.md with requirements, attribution, limitations, and versioned files.' },
  { href: '/docs/testing', title: 'Testing guide', description: 'Plan a local test, approve its effects, inspect results, and choose what to share.' },
  { href: '/docs/environments/create', title: 'Create an environment', description: 'Start with the complete bakery example, define roles and fixtures, then validate and publish.' },
  { href: '/docs/environments/setup', title: 'Set up for your business', description: 'Prepare an exact version, configure private data, test outcomes, and assess integration work.' },
] as const;
