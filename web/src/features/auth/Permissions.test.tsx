import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { ApplicationIdentity, Permissions, elevatedScopes, scopeLevel } from './Permissions';
it('escapes unverified identities and displays exact unknown requested permissions', () => {
  const markup = renderToStaticMarkup(<><ApplicationIdentity name="<img src=x onerror=alert(1)>" /><Permissions scopes={['custom:write', '<script>alert(1)</script>', 'offline_access', 'constructor', '__proto__']} descriptions={{ 'projects:read': 'Read projects.' }} /></>);
  expect(markup).toContain('Identity not verified'); expect(markup).toContain('&lt;img'); expect(markup).not.toContain('<img');
  expect(markup).toContain('&lt;script&gt;'); expect(markup).toContain('custom:write'); expect(markup).toContain('refresh authorization'); expect(markup).not.toContain('Read projects.');
});

it('shows where approval is sent: local, recognized, and an unrecognized look-alike', () => {
  const local = renderToStaticMarkup(<ApplicationIdentity name="Some CLI" app={{ kind: 'local', label: null, destinations: ['127.0.0.1:43123'], claims_to_be: null }} />);
  expect(local).toContain('runs on your computer'); expect(local).toContain('127.0.0.1:43123'); expect(local).not.toContain('Unrecognized');
  const known = renderToStaticMarkup(<ApplicationIdentity name="Claude" app={{ kind: 'recognized', label: 'Claude', destinations: ['claude.ai'], claims_to_be: null }} />);
  expect(known).toContain('<strong>claude.ai</strong>'); expect(known).toContain('belongs to Claude'); expect(known).not.toContain('Unrecognized');
  const fake = renderToStaticMarkup(<ApplicationIdentity name="Claude" app={{ kind: 'unrecognized', label: null, destinations: ['evil.example'], claims_to_be: 'Claude' }} />);
  expect(fake).toContain('Unrecognized application'); expect(fake).toContain('role="alert"');
  expect(fake).toContain('<strong>evil.example</strong>'); expect(fake).toContain('does not send you to Claude'); expect(fake).toContain('Identity not verified');
  const hostile = renderToStaticMarkup(<ApplicationIdentity name="x" app={{ kind: 'unrecognized', label: null, destinations: ['<img src=x onerror=alert(1)>'], claims_to_be: null }} />);
  expect(hostile).toContain('&lt;img'); expect(hostile).not.toContain('<img');
});

const DESCRIBED = { 'projects:read': 'Read.', 'profile:read': 'Identity.', 'projects:draft': 'Draft.', 'projects:update': 'Update.', 'community:write': 'Notes.', 'tests:submit': 'Upload.', 'projects:publish': 'Publish.', 'builds:publish': 'Publish build.' };
it('puts what can change or publish ahead of what only reads, and keeps the publication caveat', () => {
  const markup = renderToStaticMarkup(<Permissions scopes={['projects:read', 'projects:draft', 'projects:publish', 'offline_access', 'custom:x']} descriptions={DESCRIBED} />);
  const order = ['Can publish for you', 'Can change your data', 'Read only', 'Sign-in and session', 'Other requested permissions'].map((title) => markup.indexOf(title));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(markup).toContain('still needs your separate approval');
  expect(renderToStaticMarkup(<Permissions scopes={['projects:read', 'profile:read']} descriptions={DESCRIBED} />)).not.toContain('Can change your data');
});
it('classifies every product scope by its action and never treats an unknown scope as read-only', () => {
  const levels = Object.fromEntries(Object.keys(DESCRIBED).map((scope) => [scope, scopeLevel(scope, true)]));
  expect(levels).toEqual({
    'projects:read': 'read', 'profile:read': 'read', 'projects:draft': 'change', 'projects:update': 'change',
    'community:write': 'change', 'tests:submit': 'change', 'projects:publish': 'publish', 'builds:publish': 'publish',
  });
  expect(scopeLevel('projects:read', false)).toBe('other');
  expect(scopeLevel('offline_access', false)).toBe('protocol');
  expect(elevatedScopes(['projects:read', 'projects:draft', 'projects:publish', 'custom:write'], DESCRIBED)).toEqual(['projects:draft', 'projects:publish']);
});
