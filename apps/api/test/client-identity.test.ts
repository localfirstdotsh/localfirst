import { describe, expect, it } from 'vitest';
import { describeClient } from '../src/auth/client-identity.js';

const describeUris = (redirectUris: unknown, name: string | null = 'Some app') => describeClient({ name, redirectUris });

describe('consent client identity', () => {
  it('treats only http loopback callbacks as an app on this computer', () => {
    expect(describeUris(['http://localhost:43123/callback', 'http://127.0.0.1:5000/cb', 'http://[::1]:9/x'])).toMatchObject({ kind: 'local', label: null });
    expect(describeUris(['http://localhost.evil.example/cb']).kind).toBe('unrecognized');
    expect(describeUris(['https://localhost:1/cb']).kind).toBe('unrecognized');
    expect(describeUris(['http://localhost:1/cb', 'https://evil.example/cb']).kind).toBe('unrecognized');
  });

  it('recognizes a callback on a known app host and names it', () => {
    expect(describeUris(['https://claude.ai/api/mcp/auth_callback'], 'Claude')).toEqual({
      kind: 'recognized', label: 'Claude', destinations: ['claude.ai'], claims_to_be: null,
    });
    expect(describeUris(['https://chatgpt.com/connector/oauth/abc']).label).toBe('ChatGPT');
    expect(describeUris(['https://www.cursor.com/agents/mcp/oauth/callback']).label).toBe('Cursor');
  });

  it('does not recognize look-alike hosts, subdomains, other schemes, or a mix of apps', () => {
    for (const uri of [
      'https://claude.ai.evil.example/cb', 'https://evil.example/claude.ai', 'https://app.claude.ai/cb',
      'http://claude.ai/cb', 'https://claude.ai@evil.example/cb', 'cursor://anysphere.cursor/oauth',
    ]) expect(describeUris([uri]).kind, uri).toBe('unrecognized');
    expect(describeUris(['https://claude.ai/cb', 'https://chatgpt.com/cb']).kind).toBe('unrecognized');
    expect(describeUris(['https://claude.ai/cb', 'https://evil.example/cb']).kind).toBe('unrecognized');
  });

  it('shows where approval goes, including custom schemes', () => {
    expect(describeUris(['https://evil.example:8443/steal', 'https://evil.example:8443/other']).destinations).toEqual(['evil.example:8443']);
    expect(describeUris(['cursor://anysphere.cursor/oauth']).destinations).toEqual(['cursor://']);
  });

  it('flags a name that imitates a known app while sending approval elsewhere', () => {
    expect(describeUris(['https://evil.example/steal'], 'Claude')).toMatchObject({ kind: 'unrecognized', claims_to_be: 'Claude' });
    expect(describeUris(['https://evil.example/steal'], 'Official ChatGPT helper').claims_to_be).toBe('ChatGPT');
    expect(describeUris(['https://evil.example/steal'], 'My notes app').claims_to_be).toBeNull();
    expect(describeUris(['http://127.0.0.1:1/cb'], 'Claude Code').claims_to_be).toBeNull();
  });

  it('never trusts missing, malformed, or non-string callbacks', () => {
    for (const bad of [null, undefined, [], 'https://claude.ai/cb', {}, [42], ['not a url'], ['https://claude.ai/cb', 'not a url']]) {
      expect(describeUris(bad).kind, JSON.stringify(bad)).toBe('unrecognized');
    }
  });
});
