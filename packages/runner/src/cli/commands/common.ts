import { parseArgs, type ParseArgsConfig } from 'node:util';
import type { LocalReport } from '@localfirst/contracts';
import type { CliEnv } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { parseRegistryOrigin } from '../registry.js';
import { readLocalReport } from '../../reports/store.js';

type OptionSpec = NonNullable<ParseArgsConfig['options']>;

/** Strict argument parsing: an unknown flag (for example `--yes`) is a usage error. */
export function parse<const O extends OptionSpec>(argv: string[], options: O, positionals: { min: number; max: number }) {
  let result;
  try {
    result = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (cause) {
    throw usageError((cause as Error).message);
  }
  if (result.positionals.length < positionals.min || result.positionals.length > positionals.max) {
    throw usageError(
      positionals.min === positionals.max
        ? `Expected ${positionals.min} argument(s), got ${result.positionals.length}.`
        : `Expected ${positionals.min}-${positionals.max} arguments, got ${result.positionals.length}.`,
    );
  }
  return result as { values: Record<string, string | boolean | undefined>; positionals: string[] };
}

export const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The registry origin: `--registry`, then `LOCALFIRST_REGISTRY`, then `fallback`. Only
 * commands that pass a fallback have a default; the rest require an explicit registry.
 */
export function registryOrigin(env: CliEnv, flag: string | undefined, fallback?: string): string {
  const value = flag ?? env.vars.LOCALFIRST_REGISTRY ?? fallback;
  if (!value) {
    throw new CliError('No registry configured. Pass --registry <url> or set LOCALFIRST_REGISTRY.', EXIT.usage);
  }
  return parseRegistryOrigin(value);
}

export async function loadReport(path: string): Promise<LocalReport> {
  try {
    return await readLocalReport(path);
  } catch (cause) {
    throw new CliError(`Could not read a valid local report at ${path}: ${(cause as Error).message.split('\n')[0]}`, EXIT.failed);
  }
}

export const hexOf = (digest: string) => digest.replace(/^sha256:/, '');
