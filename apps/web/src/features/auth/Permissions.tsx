import { Badge } from '../../components/ui/Badge';
import type { ClientIdentity } from '../../lib/browser-schemas';
const PROTOCOL: Record<string, string> = {
  openid: 'Identify you for this sign-in.', profile: 'Request profile information through the authentication provider.', email: 'Request your email through the authentication provider.', offline_access: 'Request refresh authorization for access after the current session.',
};
/** How much a scope lets the application do. Product scopes are named `<area>:<action>`. */
export type ScopeLevel = 'publish' | 'change' | 'read' | 'protocol' | 'other';
export function scopeLevel(scope: string, known: boolean): ScopeLevel {
  if (!known) return Object.hasOwn(PROTOCOL, scope) ? 'protocol' : 'other';
  const action = scope.split(':')[1];
  return action === 'read' ? 'read' : action === 'publish' ? 'publish' : 'change';
}
/** Scopes that let the application write or publish, for callers that warn about them. */
export function elevatedScopes(scopes: readonly string[], descriptions: Record<string, string>): string[] {
  return scopes.filter((scope) => ['publish', 'change'].includes(scopeLevel(scope, Object.hasOwn(descriptions, scope))));
}
const GROUPS: Record<ScopeLevel, { title: string; note?: string }> = {
  publish: { title: 'Can publish for you', note: 'Each publication still needs your separate approval of the exact version, unless you later let this connection publish without asking.' },
  change: { title: 'Can change your data' },
  read: { title: 'Read only' },
  protocol: { title: 'Sign-in and session' },
  other: { title: 'Other requested permissions' },
};
const ORDER: ScopeLevel[] = ['publish', 'change', 'read', 'protocol', 'other'];

export function ApplicationIdentity({ name, app = null }: { name: string | null; app?: ClientIdentity | null }) {
  return <div className="stack gap-8 browser-identity"><h2>{name?.trim() || 'Unnamed application'}</h2><div><Badge>Identity not verified</Badge></div><p className="small muted">{name ? 'Application name is self-reported, unverified.' : 'The application did not provide a display name.'}</p>{app && <Destination app={app} />}</div>;
}
/** Where approval goes is the one fact the application cannot fake, so it comes first and in plain words. */
function Destination({ app }: { app: ClientIdentity }) {
  const where = app.destinations.length ? app.destinations.join(', ') : 'an address it did not give';
  if (app.kind === 'local') return <p className="small">This application runs on your computer and receives your approval there ({where}).</p>;
  if (app.kind === 'recognized') return <p className="small">After you allow, you are sent back to <strong>{where}</strong>, which belongs to {app.label}.</p>;
  return <div className="notice stack gap-8" role="alert">
    <h3>Unrecognized application</h3>
    {app.claims_to_be && <p>Its name says <strong>{app.claims_to_be}</strong>, but it does not send you to {app.claims_to_be}’s address.</p>}
    <p>After you allow, your approval is sent to <strong>{where}</strong>. Continue only if you just started this connection yourself from an application you trust.</p>
  </div>;
}
const describeScope = (scope: string, descriptions: Record<string, string>): string => Object.hasOwn(descriptions, scope) ? descriptions[scope]! : Object.hasOwn(PROTOCOL, scope) ? PROTOCOL[scope]! : 'An additional scope is requested. Inspect its exact name before consenting.';
export interface ScopeGroup { level: ScopeLevel; title: string; note?: string; scopes: string[] }
/** Scopes by what they let the application do, most powerful first. Every scope appears exactly once, known or not. */
export function groupScopes(scopes: readonly string[], descriptions: Record<string, string>): ScopeGroup[] {
  const groups = new Map<ScopeLevel, string[]>();
  for (const scope of scopes) {
    const level = scopeLevel(scope, Object.hasOwn(descriptions, scope));
    groups.set(level, [...(groups.get(level) ?? []), scope]);
  }
  return ORDER.filter((level) => groups.has(level)).map((level) => ({ level, ...GROUPS[level], scopes: groups.get(level)! }));
}
/** The default view of what an application can do: one line per capability, no scope names. */
export function PermissionSummary({ groups }: { groups: readonly ScopeGroup[] }) {
  if (groups.length === 0) return <p className="small muted">No permissions granted.</p>;
  return <ul className="permission-summary">{groups.map((group) => <li key={group.level} data-level={group.level}><span>{group.title}</span><span className="muted">{group.scopes.length}</span></li>)}</ul>;
}
/** One capability with each exact scope and what it allows. */
export function PermissionGroup({ group, descriptions }: { group: ScopeGroup; descriptions: Record<string, string> }) {
  return <section className="stack gap-8 permission-group" data-level={group.level}>
    <div className="permission-group-head"><h3 className="section-title">{group.title}</h3><span className="small muted">{group.scopes.length} {group.scopes.length === 1 ? 'permission' : 'permissions'}</span></div>
    {group.note && <p className="small muted">{group.note}</p>}
    <ul className="permission-list">{group.scopes.map((scope, index) => <li key={`${scope}-${index}`}><code>{scope}</code><span className="muted">{describeScope(scope, descriptions)}</span></li>)}</ul>
  </section>;
}
export function Permissions({ scopes, descriptions }: { scopes: readonly string[]; descriptions: Record<string, string> }) {
  const groups = groupScopes(scopes, descriptions);
  return <div className="stack gap-16 browser-permissions">
    {groups.length === 0 && <p className="muted">No permissions requested.</p>}
    {groups.map((group) => <section className="stack gap-8" key={group.level} data-level={group.level}><h3 className="section-title">{group.title}</h3>{group.note && <p className="small muted">{group.note}</p>}<p>{group.scopes.map((scope) => describeScope(scope, descriptions)).join(' ')}</p></section>)}
    <details><summary>Inspect all {scopes.length} exact permissions</summary><ul className="compact-list">{scopes.map((scope, index) => <li key={`${scope}-${index}`}><code>{scope}</code> — {describeScope(scope, descriptions)}</li>)}</ul></details>
  </div>;
}
export function SecurityNotice() {
  return <p className="small muted">Access never approves a publication. Every public artifact needs your separate approval, unless you later turn on Publish without asking me for that connection in Connections. This connection cannot run models, read local files, or use runtime credentials.</p>;
}
