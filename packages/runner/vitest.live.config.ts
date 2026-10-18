import { defineConfig } from 'vitest/config';

/**
 * Live runtime checks. These talk to REAL local model runtimes, so they are
 * not part of `pnpm check` (the default config only matches `*.test.ts`).
 * Run with `pnpm test:live` and the opt-in variables documented in
 * `test/live/gate.ts`.
 */
export default defineConfig({
  test: {
    include: ['test/live/**/*.live.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
