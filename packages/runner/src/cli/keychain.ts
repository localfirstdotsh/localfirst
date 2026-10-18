import type { CommandRunner } from './process.js';

export const KEYCHAIN_SERVICE = 'localfirstdotsh';

export class KeychainError extends Error {
  readonly code: 'keychain_unsupported' | 'keychain_tool_missing' | 'keychain_failed';
  constructor(code: KeychainError['code'], message: string) {
    super(message);
    this.name = 'KeychainError';
    this.code = code;
  }
}

export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
}

/** Account name for a bearer token scoped to one registry or runtime origin. */
export const registryAccount = (origin: string) => `registry:${origin}`;
/** Account name for the approval credential of one registry; kept apart from the agent-class token. */
export const approverAccount = (origin: string) => `approver:${origin}`;
export const runtimeAccount = (origin: string) => `runtime:${origin}`;

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');

/**
 * OS keychain access through the platform tool: macOS `security`, Linux
 * `secret-tool` (libsecret). Secrets are passed on stdin, never in argv, and
 * there is no plaintext-file fallback: an unsupported platform or a missing
 * tool is an error.
 */
export function systemKeychain(platform: NodeJS.Platform, run: CommandRunner): Keychain {
  const unsupported = () =>
    new KeychainError('keychain_unsupported', `No supported OS keychain on ${platform}. Tokens are never stored in a plain file.`);

  if (platform === 'darwin') {
    return {
      async get(account) {
        const result = await run('security', ['find-generic-password', '-a', account, '-s', KEYCHAIN_SERVICE, '-w']);
        if (result.errorCode === 'ENOENT') throw new KeychainError('keychain_tool_missing', 'The macOS `security` tool was not found.');
        if (result.code === 44) return null; // item not found
        if (result.code !== 0) throw new KeychainError('keychain_failed', 'Reading the keychain failed.');
        const value = result.stdout.replace(/\n$/, '');
        return value.length > 0 ? value : null;
      },
      async set(account, secret) {
        // `security -i` reads its commands from stdin, keeping the secret out of argv.
        if (/["\\\n\r]/.test(account)) throw new KeychainError('keychain_failed', 'Invalid keychain account name.');
        // `security ... -w` prints any value with non-ASCII bytes as hex, which cannot be
        // told apart from a token that is hex. Bearer tokens are printable ASCII, so refuse the rest.
        if (!/^[\x20-\x7e]+$/.test(secret)) throw new KeychainError('keychain_failed', 'Tokens must be printable ASCII to be stored in the macOS keychain.');
        const plain = `add-generic-password -a "${account}" -s ${KEYCHAIN_SERVICE} -U -X ${hex(secret)}\n`;
        const result = await run('security', ['-i'], { input: plain });
        if (result.errorCode === 'ENOENT') throw new KeychainError('keychain_tool_missing', 'The macOS `security` tool was not found.');
        if (result.code !== 0) throw new KeychainError('keychain_failed', 'Writing to the keychain failed.');
      },
    };
  }

  if (platform === 'linux') {
    return {
      async get(account) {
        const result = await run('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account]);
        if (result.errorCode === 'ENOENT') throw new KeychainError('keychain_tool_missing', '`secret-tool` (libsecret) is not installed.');
        if (result.code === 1 && result.stdout === '') return null; // not found
        if (result.code !== 0) throw new KeychainError('keychain_failed', 'Reading the keychain failed.');
        return result.stdout.length > 0 ? result.stdout : null;
      },
      async set(account, secret) {
        const result = await run(
          'secret-tool',
          ['store', `--label=${KEYCHAIN_SERVICE} ${account}`, 'service', KEYCHAIN_SERVICE, 'account', account],
          { input: secret },
        );
        if (result.errorCode === 'ENOENT') throw new KeychainError('keychain_tool_missing', '`secret-tool` (libsecret) is not installed.');
        if (result.code !== 0) throw new KeychainError('keychain_failed', 'Writing to the keychain failed.');
      },
    };
  }

  return {
    get: async () => {
      throw unsupported();
    },
    set: async () => {
      throw unsupported();
    },
  };
}
