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
  /** Read one trimmed line; EOF is an empty answer. */
  readLine(question: string): Promise<string>;
  /** Read a secret without echoing it. */
  readSecret(prompt: string): Promise<string>;
}

// C0 controls except tab and newline, DEL, C1 controls (including the 8-bit CSI),
// and invisible format characters: zero-width, bidirectional, line separators, BOM.
// eslint-disable-next-line no-control-regex
const UNSAFE_FOR_TERMINAL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Text from outside this CLI (a registry, a draft author) made safe to print:
 * every character that could move the cursor, recolor, or hide text is shown
 * as a visible `\u{XXXX}` escape, so what a person reads is what was sent.
 */
export function terminalSafe(text: string): string {
  return text.replace(UNSAFE_FOR_TERMINAL, (char) => `\\u{${char.charCodeAt(0).toString(16).padStart(4, '0')}}`);
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
  const readLine = (question: string) =>
    new Promise<string>((resolve) => {
      const rl = createInterface({ input: stdin, output: stdout, terminal: isTTY });
      let answered = false;
      rl.question(question, (answer) => {
        answered = true;
        rl.close();
        resolve(answer.trim());
      });
      rl.on('close', () => {
        if (!answered) resolve('');
      });
    });
  return {
    isTTY,
    out: (text) => void stdout.write(text),
    err: (text) => void stderr.write(text),
    ask: async (question) => (await readLine(question)).toLowerCase() === 'yes',
    readLine,
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
