/**
 * Structured logging (BACKEND_PRD section 19.3).
 *
 * Logs carry request/job IDs, route or tool names, status, actor identifiers,
 * a safe error class, and latency. They never carry manifests, commands,
 * private inputs or results, authorization headers, cookies, authorization
 * codes, or token responses.
 */

import { pino, type Logger } from 'pino';

const REDACTED = '[redacted]';

/** Field names that must never reach a log line. */
const FORBIDDEN_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'secret',
  'client_secret',
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'token',
  'project_md',
  'markdown',
  'manifest',
  'payload',
  'files',
  'content',
  'prompt',
  'messages',
  'cases',
  'fixture',
  'evidence',
]);

let root: Logger | null = null;
let listener: ((line: string) => void) | null = null;

function rootLogger(): Logger {
  root ??= pino({
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service: 'localfirst-backend' },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'res.headers["set-cookie"]',
        '*.authorization',
        '*.cookie',
        '*.token',
        '*.access_token',
        '*.refresh_token',
        '*.client_secret',
        '*.password',
      ],
      censor: REDACTED,
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    hooks: {
      streamWrite: (line) => {
        listener?.(line);
        return line;
      },
    },
  });
  return root;
}

export function createLogger(component: string): Logger {
  return rootLogger().child({ component });
}

/**
 * Drop content-bearing fields before logging. Logs store digests and IDs.
 */
export function safeLogFields(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
      continue;
    }
    if (entry === null || entry === undefined) continue;
    if (typeof entry === 'object') {
      out[key] = Array.isArray(entry) ? `[${entry.length} items]` : '[object]';
      continue;
    }
    out[key] = entry;
  }
  return out;
}

/** Test helper: reset the memoized root logger. */
export function resetLogger(): void {
  root = null;
}

/** Test helper: also hand every serialized log line to `next` (null stops). */
export function observeLogLines(next: ((line: string) => void) | null): void {
  listener = next;
}
