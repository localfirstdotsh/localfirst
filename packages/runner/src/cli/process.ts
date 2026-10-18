import { execFile, spawn } from 'node:child_process';

export interface CommandResult {
  /** Exit code, or null if the process could not be started or timed out. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `ENOENT` and similar start failures. */
  errorCode: string | null;
}

/** Runs one program with an argument vector (never a shell). Secrets travel on stdin only. */
export type CommandRunner = (
  command: string,
  args: string[],
  options?: { input?: string; timeoutMs?: number },
) => Promise<CommandResult>;

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: options.timeoutMs ?? 10_000, maxBuffer: 1024 * 1024, shell: false },
      (error, stdout, stderr) => {
        const failure = error as (NodeJS.ErrnoException & { code?: string | number }) | null;
        resolve({
          code: failure ? (typeof failure.code === 'number' ? failure.code : null) : 0,
          stdout,
          stderr,
          errorCode: failure && typeof failure.code === 'string' ? failure.code : null,
        });
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(options.input ?? '');
  });

/**
 * Runs one program attached to this terminal (never a shell), for a command the
 * person drives themselves, such as an application's own browser sign-in. It
 * has no timeout because the person is present and can interrupt it.
 */
export type InteractiveRunner = (command: string, args: string[]) => Promise<{ code: number | null; errorCode: string | null }>;

export const runInteractive: InteractiveRunner = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit', shell: false });
    child.on('error', (error: NodeJS.ErrnoException) => resolve({ code: null, errorCode: error.code ?? 'ERROR' }));
    child.on('exit', (code) => resolve({ code, errorCode: null }));
  });
