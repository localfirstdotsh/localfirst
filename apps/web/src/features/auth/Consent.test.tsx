import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { Consent } from './Consent';
import type { ConsentData } from '../../lib/browser-schemas';

const base: ConsentData = {
  auth_base_path: '/api/auth', sign_in_enabled: true, resource: 'https://registry.example.test/mcp',
  scope_descriptions: { 'projects:read': 'Read.', 'projects:publish': 'Publish.' },
  client_id: 'abc', client_name: 'Claude', app: null, scopes: ['projects:read', 'projects:publish'],
};
const render = (data: Partial<ConsentData>) => renderToStaticMarkup(<Consent data={{ ...base, ...data }} query="q=1" />);
const fake: ConsentData['app'] = { kind: 'unrecognized', label: null, destinations: ['evil.example'], claims_to_be: 'Claude' };

it('warns when an unrecognized application asks to change or publish, and not for read-only or known apps', () => {
  const warned = render({ app: fake });
  expect(warned).toContain('wants to do more than read'); expect(warned).toContain('1 permission'); expect(warned).toContain('evil.example');
  expect(render({ app: fake, scopes: ['projects:read'] })).not.toContain('wants to do more than read');
  expect(render({ app: { kind: 'recognized', label: 'Claude', destinations: ['claude.ai'], claims_to_be: null } })).not.toContain('wants to do more than read');
  expect(render({ app: { kind: 'local', label: null, destinations: ['127.0.0.1:1'], claims_to_be: null } })).not.toContain('wants to do more than read');
});
