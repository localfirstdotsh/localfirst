import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Home {
  configDir: string;
  dataDir: string;
  plansDir: string;
  bundlesDir: string;
  reportsDir: string;
  exportsDir: string;
  approvalsDir: string;
  configFile: string;
}

/**
 * Local state locations. `LOCALFIRST_HOME` puts everything under one directory
 * (used by tests); otherwise XDG config/data locations. Nothing is created here.
 */
export function resolveHome(env: Record<string, string | undefined>, home: string = homedir()): Home {
  const override = env.LOCALFIRST_HOME;
  const configDir = override
    ? join(override, 'config')
    : join(env.XDG_CONFIG_HOME || join(home, '.config'), 'localfirstdotsh');
  const dataDir = override
    ? join(override, 'data')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'localfirstdotsh');
  return {
    configDir,
    dataDir,
    plansDir: join(dataDir, 'plans'),
    bundlesDir: join(dataDir, 'bundles'),
    reportsDir: join(dataDir, 'reports'),
    exportsDir: join(dataDir, 'exports'),
    approvalsDir: join(dataDir, 'approvals'),
    configFile: join(configDir, 'config.json'),
  };
}

/** Create a private (0700) directory, including parents. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}
