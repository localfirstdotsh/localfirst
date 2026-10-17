import { fileURLToPath } from 'node:url';
import type { NextConfig } from 'next';

/**
 * Public website (FRONTEND_PRD sections 3.3, 17, 18). Public pages are rendered
 * from the registry API on the server. Session-aware pages use uncached,
 * session-only backend read models; API/auth/MCP requests are proxied at runtime.
 */
const config: NextConfig = {
  poweredByHeader: false,
  // A self-contained server for the container image (web/Dockerfile sets this). It stays off for
  // `next start`, which the browser tests and local use rely on. The tracing root is the repository
  // so the workspace package `@localfirst/contracts` is traced into the output.
  ...(process.env.NEXT_OUTPUT === 'standalone'
    ? { output: 'standalone' as const, outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)) }
    : {}),
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
