import { describe, expect, it, vi } from 'vitest';
import { routableAddresses, watchNetwork, type InterfaceTable } from '../src/index.js';

const entry = (address: string, internal = false) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4', internal }) as never;

const loopbackOnly: InterfaceTable = { lo0: [entry('127.0.0.1', true), entry('::1', true), entry('fe80::1', true)] };
const linkLocalOnly: InterfaceTable = {
  ...loopbackOnly,
  awdl0: [entry('fe80::8877:63ff:fe25:9eed')],
  en1: [entry('169.254.12.3')],
};
const online: InterfaceTable = { ...linkLocalOnly, en0: [entry('10.0.0.62')] };

describe('routableAddresses', () => {
  it('ignores loopback and link-local addresses', () => {
    expect(routableAddresses(loopbackOnly)).toEqual([]);
    expect(routableAddresses(linkLocalOnly)).toEqual([]);
  });

  it('counts private, global, unique-local, and tunnel addresses as a path off the link', () => {
    for (const address of ['10.0.0.62', '192.168.1.5', '8.8.8.8', '2601:601::1', 'fd7a:115c:a1e0::a536', '100.92.74.91']) {
      expect(routableAddresses({ x: [entry(address)] })).toEqual([address]);
    }
  });

  it('strips a zone id before classifying', () => {
    expect(routableAddresses({ x: [entry('fe80::1%en0')] })).toEqual([]);
  });
});

describe('watchNetwork', () => {
  it('reports no_route_observed only when every sample was clean', () => {
    const watch = watchNetwork({ interfaces: () => linkLocalOnly });
    expect(watch.stop()).toEqual({ observation: 'no_route_observed', samples: 2 });
  });

  it('reports not_run when the machine was online at the start', () => {
    expect(watchNetwork({ interfaces: () => online }).stop().observation).toBe('not_run');
  });

  it('catches a route that appears mid-run, and one that is gone again by the end', () => {
    vi.useFakeTimers();
    try {
      let table = linkLocalOnly;
      const watch = watchNetwork({ interfaces: () => table, intervalMs: 100 });
      table = online;
      vi.advanceTimersByTime(100);
      table = linkLocalOnly;
      const result = watch.stop();
      expect(result.observation).toBe('not_run');
      expect(result.samples).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent and stops sampling', () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const watch = watchNetwork({ interfaces: () => (reads += 1, linkLocalOnly), intervalMs: 50 });
      const first = watch.stop();
      vi.advanceTimersByTime(500);
      expect(watch.stop()).toBe(first);
      expect(reads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
