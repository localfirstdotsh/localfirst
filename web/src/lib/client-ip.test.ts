import { describe, expect, it } from 'vitest';
import { clientIpHeaderName, parseVisitorIp } from './client-ip';

describe('clientIpHeaderName', () => {
  it('is off unless a header is configured', () => {
    expect(clientIpHeaderName({})).toBeNull();
    expect(clientIpHeaderName({ LOCALFIRST_CLIENT_IP_HEADER: '   ' })).toBeNull();
  });

  it('accepts a plain header name and normalizes its case', () => {
    expect(clientIpHeaderName({ LOCALFIRST_CLIENT_IP_HEADER: 'CF-Connecting-IP' })).toBe('cf-connecting-ip');
  });

  it('refuses headers a visitor can write or that hold chains, so it cannot be spoofed by configuration', () => {
    for (const name of ['X-Forwarded-For', 'forwarded', 'x-forwarded-host']) {
      expect(clientIpHeaderName({ LOCALFIRST_CLIENT_IP_HEADER: name }), name).toBeNull();
    }
  });

  it('refuses a value that is not a header name', () => {
    for (const name of ['bad name', 'a:b', 'x\ninjected', 'a'.repeat(80)]) {
      expect(clientIpHeaderName({ LOCALFIRST_CLIENT_IP_HEADER: name }), name).toBeNull();
    }
  });
});

describe('parseVisitorIp', () => {
  it('accepts one IPv4 or IPv6 address', () => {
    expect(parseVisitorIp('203.0.113.9')).toBe('203.0.113.9');
    expect(parseVisitorIp(' 2001:db8::42 ')).toBe('2001:db8::42');
  });

  it('rejects lists, names, ports, and anything that is not exactly one address', () => {
    for (const value of ['1.2.3.4, 5.6.7.8', 'localhost', '1.2.3.4:80', '999.1.1.1', '', null, undefined, '1.2.3.4\r\nx-evil: 1']) {
      expect(parseVisitorIp(value as string | null | undefined), String(value)).toBeNull();
    }
  });
});
