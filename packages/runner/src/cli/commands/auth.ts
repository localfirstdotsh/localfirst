import type { CliEnv } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { KeychainError, registryAccount, runtimeAccount } from '../keychain.js';
import { parse, registryOrigin, str } from './common.js';
import { resolveEndpoint } from '../runtime.js';

/**
 * `auth set-token [--registry <url> | --lmstudio-endpoint <url>]`: read a token
 * from the terminal without echo and store it in the OS keychain. The token is
 * never printed, logged, or put on a command line.
 */
export async function authSetToken(env: CliEnv, argv: string[]): Promise<number> {
  const { values } = parse(argv, { registry: { type: 'string' }, 'lmstudio-endpoint': { type: 'string' } }, { min: 0, max: 0 });
  const lmstudio = values['lmstudio-endpoint'];
  if (lmstudio !== undefined && values.registry !== undefined) throw usageError('Choose either --registry or --lmstudio-endpoint.');

  const account =
    lmstudio !== undefined
      ? runtimeAccount(resolveEndpoint('lmstudio', typeof lmstudio === 'string' ? lmstudio : undefined))
      : registryAccount(registryOrigin(env, str(values.registry)));

  const token = (await env.io.readSecret(`Token for ${account}: `)).trim();
  if (token.length === 0) throw usageError('No token entered.');
  try {
    await env.keychain.set(account, token);
  } catch (cause) {
    if (cause instanceof KeychainError) throw new CliError(cause.message, EXIT.failed);
    throw cause;
  }
  env.io.out(`Token stored in the OS keychain for ${account}.\n`);
  return EXIT.ok;
}
