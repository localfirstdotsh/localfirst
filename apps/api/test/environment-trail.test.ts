import { describe, expect, it } from 'vitest';
import { runEnvironmentVerification, validateLocalOllamaEndpoint } from '../src/verification/environments.js';

describe('private example verification entry point', () => {
  it('restricts recording to a plain loopback Ollama origin', () => {
    expect(validateLocalOllamaEndpoint('http://127.0.0.1:11434')).toBe('http://127.0.0.1:11434');
    expect(validateLocalOllamaEndpoint('http://[::1]:11434')).toBe('http://[::1]:11434');
    for (const endpoint of ['https://remote.example', 'http://user:password@localhost:11434', 'http://localhost:11434/api/chat', 'http://localhost:11434?token=x', 'file:///tmp/socket']) {
      expect(() => validateLocalOllamaEndpoint(endpoint)).toThrow();
    }
  });
  it('refuses to load artifacts, touch a database or probe a runtime without live opt-in', async () => {
    await expect(runEnvironmentVerification({ live: false as true, endpoint: 'http://127.0.0.1:11434', model: 'installed' })).rejects.toThrow('Explicit live inference');
  });
  it('rejects an unknown or duplicate example before starting any resources', async () => {
    await expect(runEnvironmentVerification({ live: true, endpoint: 'http://localhost:11434', model: 'installed', examples: ['unknown' as 'bakery'] })).rejects.toThrow('Unknown example');
    await expect(runEnvironmentVerification({ live: true, endpoint: 'http://localhost:11434', model: 'installed', examples: ['bakery', 'bakery'] })).rejects.toThrow('unique');
  });
});
