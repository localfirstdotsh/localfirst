import type { CliEnv } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { hostname } from 'node:os';
import { KeychainError, approverAccount, registryAccount, runtimeAccount } from '../keychain.js';
import { RegistryClient, RegistryError } from '../registry.js';
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

/**
 * `auth approver-login [--registry <url>] [--label <name>]`: link this machine
 * so `contribution approve` can record your decision from the terminal. The
 * machine shows a short code; you approve that code in a signed-in browser
 * session, which is what makes this a person's decision and not an agent's.
 * The resulting credential goes into the OS keychain, separate from any agent
 * token, and can only record or read a publication decision.
 */
export async function authApproverLogin(env: CliEnv, argv: string[]): Promise<number> {
  const { values } = parse(argv, { registry: { type: 'string' }, label: { type: 'string' } }, { min: 0, max: 0 });
  const origin = registryOrigin(env, str(values.registry));
  const client = new RegistryClient(origin, env.fetch);
  const label = (str(values.label) ?? hostname()).slice(0, 60);

  let started;
  try {
    started = await client.startApproverLink(label);
  } catch (cause) {
    if (cause instanceof RegistryError) throw new CliError(`Could not start linking (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    throw cause;
  }
  env.io.out(
    `To link this machine (${label}), open:\n  ${started.verification_url}\n` +
      `and approve the code ${started.user_code} in your signed-in browser.\n` +
      'Only approve if that code matches. This does not publish anything.\n',
  );
  try {
    if (new URL(started.verification_url).origin === origin) await env.openUrl(started.verification_url);
  } catch {
    // Opening a browser is a convenience; the URL is printed above.
  }

  const deadline = env.now().getTime() + started.expires_in * 1000;
  let interval = Math.max(1, started.interval) * 1000;
  while (env.now().getTime() < deadline) {
    await env.sleep(interval);
    let poll;
    try {
      poll = await client.redeemApproverLink(started.link_id, started.poll_secret);
    } catch (cause) {
      if (cause instanceof RegistryError && cause.status === 410) {
        throw new CliError(`Linking did not complete: ${cause.message}`, EXIT.failed);
      }
      if (cause instanceof RegistryError) throw new CliError(`Linking failed (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
      throw cause;
    }
    if (poll.status === 'issued') {
      try {
        await env.keychain.set(approverAccount(origin), poll.credential);
      } catch (cause) {
        if (cause instanceof KeychainError) throw new CliError(cause.message, EXIT.failed);
        throw cause;
      }
      env.io.out(`Linked. The approval credential is in the OS keychain for ${origin} and expires ${poll.expires_at}.\nRevoke it any time under Approval devices in your account.\n`);
      return EXIT.ok;
    }
    interval = Math.max(1, poll.interval) * 1000;
  }
  throw new CliError('The code expired before it was approved. Run the command again.', EXIT.failed);
}
