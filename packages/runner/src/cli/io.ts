import { createInterface } from 'node:readline';
import type { ApprovalPrompter } from '../consent/plan.js';
import { refusal } from './errors.js';

/** All terminal interaction. Tests substitute a scripted implementation. */
export interface Io {
  /** True only when both stdin and stdout are terminals. */
  readonly isTTY: boolean;
  out(text: string): void;
  err(text: string): void;
  /** Ask for an exact `yes`. Anything else, or EOF, is a no. */
  ask(question: string): Promise<boolean>;
  /** Read a secret without echoing it. */
  readSecret(prompt: string): Promise<string>;
}

/** Require a terminal for an interactive approval; there is no flag or variable that bypasses this. */
export function requireTty(io: Io, what: string): void {
  if (!io.isTTY) {
    throw refusal(`${what} needs an interactive terminal. There is no non-interactive override.`);
  }
}

/** The plan approval prompt: shows the exact summary and plan digest, then asks. */
export function ttyPrompter(io: Io): ApprovalPrompter {
  return {
    async confirm(summary, planDigest) {
      requireTty(io, 'Approving a plan');
      io.out(`${summary}\n`);
      return io.ask(`Run exactly this plan (${planDigest})? Type "yes" to approve: `);
    },
  };
}

export function createTerminalIo(
  stdin: NodeJS.ReadStream = process.stdin,
  stdout: NodeJS.WriteStream = process.stdout,
  stderr: NodeJS.WriteStream = process.stderr,
): Io {
  const isTTY = Boolean(stdin.isTTY && stdout.isTTY);
  return {
    isTTY,
    out: (text) => void stdout.write(text),
    err: (text) => void stderr.write(text),
    ask(question) {
      return new Promise((resolve) => {
        const rl = createInterface({ input: stdin, output: stdout, terminal: isTTY });
        let answered = false;
        rl.question(question, (answer) => {
          answered = true;
          rl.close();
          resolve(answer.trim().toLowerCase() === 'yes');
        });
        rl.on('close', () => {
          if (!answered) resolve(false);
        });
      });
    },
    readSecret(prompt) {
      return new Promise((resolve, reject) => {
        if (!isTTY) return reject(refusal('Reading a secret needs an interactive terminal.'));
        stdout.write(prompt);
        const chunks: string[] = [];
        const wasRaw = stdin.isRaw;
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const finish = (value: string | Error) => {
          stdin.setRawMode(wasRaw);
          stdin.pause();
          stdin.off('data', onData);
          stdout.write('\n');
          if (value instanceof Error) reject(value);
          else resolve(value);
        };
        const onData = (data: string) => {
          for (const char of data) {
            if (char === '\r' || char === '\n') return finish(chunks.join(''));
            if (char === '\u0003') return finish(refusal('Cancelled.'));
            if (char === '\u007f' || char === '\b') chunks.pop();
            else chunks.push(char);
          }
        };
        stdin.on('data', onData);
      });
    },
  };
}
