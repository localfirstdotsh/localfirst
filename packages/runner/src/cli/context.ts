import type { compareReports } from '../reports/compare.js';
import type { BuildHardware } from '../reports/upload.js';
import type { Home } from './paths.js';
import type { Io } from './io.js';
import type { Keychain } from './keychain.js';
import type { CommandRunner, InteractiveRunner } from './process.js';
import type { NetworkWatch } from '../sensors/network.js';

/** Everything a command touches outside its own arguments, injected so tests control it. */
export interface CliEnv {
  io: Io;
  home: Home;
  /** Process environment (read-only). `LOCALFIRST_REGISTRY` names the registry origin. */
  vars: Record<string, string | undefined>;
  fetch: typeof fetch;
  keychain: Keychain;
  runCommand: CommandRunner;
  /** A program the person drives in this terminal; used only after their explicit approval. */
  runInteractive: InteractiveRunner;
  platform: NodeJS.Platform;
  /** The user's home directory, used only to locate LM Studio's own files during authorized discovery. */
  userHome: string;
  now: () => Date;
  /** Aborts a running test (SIGINT in the real binary). */
  signal?: AbortSignal;
  compare: typeof compareReports;
  openUrl: (url: string) => Promise<void>;
  /** Coarse machine summary; only called after the user opts in at export review. */
  hardware: () => BuildHardware | null;
  /** Starts sampling the machine's interfaces for the length of a run. */
  watchNetwork: () => NetworkWatch;
  /** Wait between polls; replaced in tests. */
  sleep: (ms: number) => Promise<void>;
  /** Short random token for run IDs. */
  randomId: () => string;
  cwd: string;
}
