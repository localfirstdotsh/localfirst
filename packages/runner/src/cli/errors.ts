/** A user-facing failure with a process exit code. */
export const EXIT = { ok: 0, failed: 1, usage: 2, refused: 3 } as const;

export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number = EXIT.failed) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
  }
}

export const usageError = (message: string) => new CliError(message, EXIT.usage);
export const refusal = (message: string) => new CliError(message, EXIT.refused);
