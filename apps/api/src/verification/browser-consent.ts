import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium, type Page } from 'playwright-core';
import { makeSignature } from 'better-auth/crypto';
import { EXAMPLE_PROJECT_MD, EXAMPLE_TEST_PATH, EXAMPLE_TEST_YAML } from '@localfirst/contracts';
import { auth, resetAuth } from '../auth/instance.js';
import { config, setConfig } from '../config.js';
import { createAccount, mintToken } from './evidence-fixture.js';
import { isolatedDatabases, startServer } from './harness.js';
import { startWebsite } from './website.js';

/**
 * BACKEND_PRD section 20.4 "browser consent flow", in a real browser: the
 * locally installed Google Chrome (no browser download), the Next.js
 * review page with its nonce CSP and React approval controls, and an agent on
 * the hosted MCP transport on either side of the human decision.
 *
 * The session cookie is minted with Better Auth's own session store and
 * cookie signature, exactly as a completed sign-in leaves it. Signing in
 * through GitHub itself needs the real provider and is not exercised here.
 */

// Browser-side callbacks run in the page, serialized by Playwright: they reach
// its globals through `globalThis` because this package compiles without DOM
// types, and the page's CSP forbids evaluating strings instead.
const resources = await isolatedDatabases();
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let website: Awaited<ReturnType<typeof startWebsite>> | undefined;
let attacker: ReturnType<typeof createServer> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const steps: Array<{ step: string; passed: boolean; detail?: unknown }> = [];
const step = (name: string, passed: boolean, detail?: unknown) => {
  steps.push({ step: name, passed, ...(detail === undefined ? {} : { detail }) });
};

try {
  server = await startServer();
  website = await startWebsite(server.baseUrl);
  const base = website.baseUrl;
  const person = await createAccount();
  const agentToken = await mintToken(person.userId, 'projects:read projects:draft projects:publish', config().mcpResource);
  const restToken = await mintToken(person.userId, 'projects:read projects:draft projects:publish');

  let rpcId = 0;
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${agentToken}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: (rpcId += 1), method: 'tools/call', params: { name, arguments: args } }),
    });
    const text = await response.text();
    const payload = text.startsWith('event:') || text.startsWith('data:')
      ? JSON.parse(text.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join(''))
      : JSON.parse(text);
    assert.ok(response.ok && payload.result, `MCP ${response.status}: ${JSON.stringify(payload)}`);
    return payload.result as { isError?: boolean; structuredContent: Record<string, any> };
  };

  // 1. The agent drafts; it cannot publish without a person.
  const created = await mcp('contribution_create_draft', {
    kind: 'project', project_md: EXAMPLE_PROJECT_MD, files: [{ path: EXAMPLE_TEST_PATH, content: EXAMPLE_TEST_YAML }], idempotency_key: 'browser-consent-create',
  });
  assert.ok(!created.isError, JSON.stringify(created.structuredContent));
  let draft = created.structuredContent as { draft_id: string; revision: number; payload_digest: string; review_url: string; warning_codes: string[] };
  const unapproved = await mcp('contribution_publish', {
    draft_id: draft.draft_id, approval_id: '00000000-0000-4000-8000-000000000000', draft_revision: draft.revision, payload_digest: draft.payload_digest, idempotency_key: 'browser-consent-early',
  });
  step('agent cannot publish before a person approves', unapproved.structuredContent.error?.code === 'APPROVAL_REQUIRED', unapproved.structuredContent.error?.code);

  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // 2. Without a session the review page is refused.
  const anonymous = await browser.newContext();
  const refused = await (await anonymous.newPage()).goto(draft.review_url);
  step('review page refuses a visitor without a session', refused?.status() === 200 && refused.url().includes('/sign-in?next='), refused?.url());
  await anonymous.close();

  // 3. A page on another site cannot approve with the person's cookie.
  const context = await browser.newContext();
  const ctx = await (auth() as unknown as { $context: Promise<any> }).$context;
  const session = await ctx.internalAdapter.createSession(person.userId, false);
  await context.addCookies([{
    name: ctx.authCookies.sessionToken.name, value: `${session.token}.${await makeSignature(session.token, ctx.secret)}`,
    url: base, httpOnly: true, sameSite: 'Lax',
  }]);
  const approvalUrl = `${base}/api/v1/drafts/${draft.draft_id}/approval`;
  const body = JSON.stringify({ draft_revision: draft.revision, payload_digest: draft.payload_digest, acknowledged_warning_codes: draft.warning_codes, decision: 'approved' });
  attacker = createServer((_request, response) => {
    response.setHeader('content-type', 'text/html');
    response.end(`<!doctype html><title>elsewhere</title><form id="f" method="POST" action="${approvalUrl}" enctype="text/plain" target="sink"><input name='${body.slice(0, -1)},"x":"' value='"}'></form><iframe name="sink"></iframe><script>
      fetch(${JSON.stringify(approvalUrl)}, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: ${JSON.stringify(body)} })
        .then((r) => { document.title = 'fetch:' + r.status; }, () => { document.title = 'fetch:blocked'; });
      document.getElementById('f').submit();
    </script>`);
  }).listen(0, 'localhost');
  await once(attacker, 'listening');
  const attackerPort = (attacker.address() as { port: number }).port;
  const evil = await context.newPage();
  await evil.goto(`http://localhost:${attackerPort}/`);
  await evil.waitForFunction(() => (globalThis as any).document.title.startsWith('fetch:'), undefined, { timeout: 10_000 });
  await evil.waitForTimeout(500);
  const afterAttack = await mcp('draft_get', { draft_id: draft.draft_id });
  step('a cross-site page cannot approve with the session cookie', !afterAttack.structuredContent.approval, { fetch: await evil.title(), approval: afterAttack.structuredContent.approval ?? null });
  await evil.close();

  // 4. An access token cannot approve, even for its own account.
  const tokenApproval = await fetch(approvalUrl, { method: 'POST', headers: { authorization: `Bearer ${restToken}`, 'content-type': 'application/json' }, body });
  step('an access token cannot approve', tokenApproval.status === 403, tokenApproval.status);

  // 5. The person approves on the review page, in the browser.
  const page = await context.newPage();
  const problems: string[] = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  // Chrome asks every origin for /favicon.ico on its own; any other failed load is a problem.
  page.on('response', (response) => {
    if (response.status() >= 400 && new URL(response.url()).pathname !== '/favicon.ico') problems.push(`${response.status()} ${response.url()}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) problems.push(`console: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const window = (globalThis as any);
    window.document.addEventListener('securitypolicyviolation', (event: any) => {
      (window.__csp ??= []).push(`${event.violatedDirective} ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}:${event.columnNumber} ${event.sample}`);
    });
  });
  const approveInBrowser = async (target: Page, revision: number) => {
    const response = await target.goto(draft.review_url);
    assert.equal(response?.status(), 200);
    const text = await target.textContent('body');
    assert.ok(text?.includes('Approve this exact artifact'));
    for (const box of await target.$$('#review-acknowledgements input[type=checkbox]')) await box.check();
    await target.click('#approve');
    await target.getByRole('heading', { name: 'Publication approved', exact: true }).waitFor({ state: 'visible', timeout: 10_000 });
    // The decision is recorded, so the page stops offering it.
    assert.ok(!(await target.locator('#decision-area').isVisible()));
    const after = await mcp('draft_get', { draft_id: draft.draft_id });
    const approval = after.structuredContent.approval as { approval_id: string; draft_revision: number } | null;
    assert.ok(approval && approval.draft_revision === revision, JSON.stringify(after.structuredContent.approval));
    return approval.approval_id;
  };
  const firstApproval = await approveInBrowser(page, draft.revision);
  const csp = await page.evaluate(() => ((globalThis as any).__csp ?? []) as string[]);
  step('the React review page approves through the website proxy under CSP, with no errors', problems.length === 0 && csp.length === 0, { problems, csp });

  // 6. An edit after approval invalidates it.
  const edited = await mcp('draft_update', { draft_id: draft.draft_id, expected_revision: draft.revision, project_md: `${EXAMPLE_PROJECT_MD.trimEnd()}\n\nEdited after the approval.\n` });
  assert.ok(!edited.isError, JSON.stringify(edited.structuredContent));
  const stale = await mcp('contribution_publish', {
    draft_id: draft.draft_id, approval_id: firstApproval, draft_revision: draft.revision, payload_digest: draft.payload_digest, idempotency_key: 'browser-consent-stale',
  });
  step('an edit after approval stops the agent from publishing', stale.isError === true, stale.structuredContent.error?.code);

  // 7. The person approves the new revision; the agent publishes it once.
  draft = (await mcp('draft_get', { draft_id: draft.draft_id })).structuredContent as typeof draft;
  const secondApproval = await approveInBrowser(page, draft.revision);
  const published = await mcp('contribution_publish', {
    draft_id: draft.draft_id, approval_id: secondApproval, draft_revision: draft.revision, payload_digest: draft.payload_digest, idempotency_key: 'browser-consent-publish',
  });
  const replay = await mcp('contribution_publish', {
    draft_id: draft.draft_id, approval_id: secondApproval, draft_revision: draft.revision, payload_digest: draft.payload_digest, idempotency_key: 'browser-consent-again',
  });
  step('the agent publishes the approved revision, and the approval works once', published.structuredContent.visibility === 'published' && replay.isError === true,
    { visibility: published.structuredContent.visibility, second_use: replay.structuredContent.error?.code });
  const project = await fetch(`${base}/api/v1/projects/${published.structuredContent.project_id}`);
  step('the published project is public', project.status === 200, project.status);
  await page.goto(draft.review_url);
  const closedText = (await page.textContent('body')) ?? '';
  step('the review page then shows the draft as published, with nothing left to approve',
    closedText.includes('This draft was published') && closedText.includes(published.structuredContent.slug as string) && (await page.$('#approve')) === null,
    published.structuredContent.slug);

  // 8. An MCP application connects through OAuth, as Claude Code does: it
  // registers itself without a session, the person allows it on the consent
  // page, the code reaches the application's loopback callback, and the
  // application exchanges it with its PKCE verifier for an MCP token.
  const current = config();
  setConfig({ ...current, features: { ...current.features, dynamicClientRegistration: true } });
  resetAuth();
  const authBase = `${base}${config().authBasePath}`;
  const callbackUrl = 'http://localhost:43123/callback';
  const registered = await fetch(`${authBase}/oauth2/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'MCP application (verification)', redirect_uris: [callbackUrl],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none', scope: 'projects:read projects:draft',
    }),
  });
  const client = (await registered.json()) as { client_id?: string; client_secret?: string };
  step('an MCP application registers itself without a session, as a public client', registered.ok && !!client.client_id && client.client_secret === undefined, registered.status);

  const verifier = randomBytes(32).toString('base64url');
  const oauthState = randomUUID();
  const authorizeUrl = new URL(`${authBase}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: 'code', client_id: client.client_id!, redirect_uri: callbackUrl, scope: 'projects:read projects:draft',
    state: oauthState, code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', resource: config().mcpResource,
  })) authorizeUrl.searchParams.set(key, value);
  const consentTab = await context.newPage();
  const callbacks: string[] = [];
  await consentTab.route('http://localhost:43123/**', async (route) => {
    callbacks.push(route.request().url());
    await route.fulfill({ status: 200, body: 'callback reached' });
  });
  await consentTab.goto(authorizeUrl.href);
  const consentText = (await consentTab.textContent('body')) ?? '';
  await consentTab.getByRole('button', { name: 'Allow access', exact: true }).click();
  for (let waited = 0; callbacks.length === 0 && waited < 10_000; waited += 200) await consentTab.waitForTimeout(200);
  const callback = callbacks[0] ? new URL(callbacks[0]) : null;
  step('the person allows it on the consent page, and the code reaches the application',
    !!callback?.searchParams.get('code') && callback.searchParams.get('state') === oauthState && consentText.includes('self-reported, unverified'),
    { consent_page: new URL(consentTab.url()).pathname, callback: callback ? `${callback.origin}${callback.pathname}` : null });

  const tokenResponse = await fetch(`${authBase}/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: callback?.searchParams.get('code') ?? '', redirect_uri: callbackUrl,
      client_id: client.client_id!, code_verifier: verifier, resource: config().mcpResource,
    }),
  });
  const tokens = (await tokenResponse.json()) as { access_token?: string };
  step('the application exchanges the code with its PKCE verifier, and no secret, for an MCP token', tokenResponse.ok && !!tokens.access_token, tokenResponse.status);

  const toolList = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-06-18', authorization: `Bearer ${tokens.access_token ?? ''}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'tools/list', params: {} }),
  });
  const toolText = await toolList.text();
  step('the issued token works at the MCP server', toolList.ok && toolText.includes('contribution_create_draft'), toolList.status);

  const passed = steps.every((s) => s.passed);
  console.log(JSON.stringify({
    verification: 'browser-consent-flow', browser: `Google Chrome ${browser.version()} (headless, system install)`, steps, passed,
    limitation: 'The session cookie is minted with Better Auth itself; GitHub sign-in is covered by test/github-sign-in.test.ts with the GitHub endpoints simulated. The MCP application is driven by this script, not by Claude Code itself.',
  }, null, 2));
  if (!passed) process.exitCode = 1;
} finally {
  await browser?.close();
  if (attacker) attacker.close();
  await website?.close();
  if (server) await server.close();
  await resources.cleanup();
}
