import { networkInterfaces } from 'node:os';

export type InterfaceTable = ReturnType<typeof networkInterfaces>;

/**
 * What a run can claim about the network: `no_route_observed` when every sample
 * showed only loopback and link-local addresses, `not_run` otherwise (including
 * a machine that was simply online, which is not a failure).
 */
export type OfflineObservation = 'no_route_observed' | 'not_run';

const LINK_LOCAL_V4 = /^169\.254\./;
const LINK_LOCAL_V6 = /^fe[89ab][0-9a-f]:/i;

/** Addresses that could carry traffic beyond the local link: not loopback, not link-local. */
export function routableAddresses(table: InterfaceTable): string[] {
  const found: string[] = [];
  for (const entries of Object.values(table)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue;
      const address = entry.address.split('%')[0] ?? entry.address;
      if (LINK_LOCAL_V4.test(address) || LINK_LOCAL_V6.test(address)) continue;
      found.push(address);
    }
  }
  return found;
}

export interface NetworkWatchOptions {
  interfaces?: () => InterfaceTable;
  intervalMs?: number;
}

export interface NetworkWatch {
  /** Take a final sample and stop. Idempotent. */
  stop(): { observation: OfflineObservation; samples: number };
}

/**
 * Samples the machine's interface table for the length of a run. This sees
 * every process, the model runtime included, because it asks whether the
 * machine had any path off the local link at all; it does not watch or restrict
 * individual processes and changes no network setting. A path that appears and
 * disappears between two samples is not seen, and link-local neighbours are
 * not covered.
 */
export function watchNetwork(options: NetworkWatchOptions = {}): NetworkWatch {
  const read = options.interfaces ?? networkInterfaces;
  let samples = 0;
  let routable = false;
  const sample = () => {
    samples += 1;
    if (routableAddresses(read()).length > 0) routable = true;
  };
  sample();
  const timer = setInterval(sample, options.intervalMs ?? 200);
  timer.unref();
  let result: ReturnType<NetworkWatch['stop']> | null = null;
  return {
    stop() {
      if (result) return result;
      clearInterval(timer);
      sample();
      result = { observation: routable ? 'not_run' : 'no_route_observed', samples };
      return result;
    },
  };
}
