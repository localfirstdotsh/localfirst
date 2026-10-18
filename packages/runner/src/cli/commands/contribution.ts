import type { CliEnv } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { digestOf } from '@localfirst/contracts';
import { requireTty } from '../io.js';
import { KeychainError, approverAccount, registryAccount } from '../keychain.js';
import { RegistryClient, RegistryError } from '../registry.js';
import { parse, registryOrigin, str } from './common.js';

/**
 * `contribution review <draft-id> [--open]`: show where a draft stands and its
 * browser confirmation URL. Approval and publication happen in the trusted
 * browser session; the CLI never marks anything approved.
 */
export async function contributionReview(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { registry: { type: 'string' }, open: { type: 'boolean' } }, { min: 1, max: 1 });
  const draftId = positionals[0] as string;
  const origin = registryOrigin(env, str(values.registry));

  let token: string | null;
  try {
    token = await env.keychain.get(registryAccount(origin));
  } catch (cause) {
    if (cause instanceof KeychainError) throw new CliError(cause.message, EXIT.failed);
    throw cause;
  }
  if (!token) throw new CliError(`No token stored for ${origin}. Run \`localfirstdotsh auth set-token --registry ${origin}\`.`, EXIT.failed);

  let draft: Record<string, unknown>;
  try {
    draft = await new RegistryClient(origin, env.fetch, token).getDraft(draftId);
  } catch (cause) {
    if (cause instanceof RegistryError) throw new CliError(`Could not read the draft (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    throw cause;
  }

  const approval = draft.approval as { payload_digest?: string; expires_at?: string } | null | undefined;
  const warnings = Array.isArray(draft.warning_codes) ? (draft.warning_codes as string[]) : [];
  const reviewUrl = typeof draft.review_url === 'string' ? draft.review_url : null;
  env.io.out(
    [
      `Draft ${draftId} (${String(draft.kind)}): ${String(draft.state)}, revision ${String(draft.revision)}`,
      `Payload digest: ${String(draft.payload_digest)}`,
      `Warnings to acknowledge: ${warnings.length > 0 ? warnings.join(', ') : 'none'}`,
      approval
        ? `Approval on record for ${approval.payload_digest === draft.payload_digest ? 'this exact payload' : 'a DIFFERENT payload (stale)'}, expires ${approval.expires_at}`
        : 'No approval on record. Approving happens in the browser, after showing the exact artifact.',
      `Review in your browser: ${reviewUrl ?? '(none provided)'}`,
    ].join('\n') + '\n',
  );

  if (values.open === true) {
    if (!reviewUrl) throw usageError('The draft has no review URL to open.');
    if (new URL(reviewUrl).origin !== origin) {
      throw new CliError('The review URL is on a different origin than the registry; not opening it.', EXIT.refused);
    }
    await env.openUrl(reviewUrl);
    env.io.out('Opened the review page in your browser.\n');
  }
  return EXIT.ok;
}

/**
 * `contribution approve <draft-id> [--deny]`: show the exact artifact in the
 * terminal and record your decision with the approval credential linked by
 * `auth approver-login`. It needs an interactive terminal, asks for a literal
 * "yes" for each limitation and for the artifact, and names the exact revision
 * and digest it showed. The agent still publishes separately.
 */
export async function contributionApprove(env: CliEnv, argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { registry: { type: 'string' }, deny: { type: 'boolean' } }, { min: 1, max: 1 });
  const draftId = positionals[0] as string;
  const origin = registryOrigin(env, str(values.registry));
  const deny = values.deny === true;
  requireTty(env.io, 'Approving a publication');

  let credential: string | null;
  try {
    credential = await env.keychain.get(approverAccount(origin));
  } catch (cause) {
    if (cause instanceof KeychainError) throw new CliError(cause.message, EXIT.failed);
    throw cause;
  }
  if (!credential) {
    throw new CliError(`This machine is not linked as an approval device for ${origin}. Run \`localfirstdotsh auth approver-login --registry ${origin}\`.`, EXIT.failed);
  }
  const client = new RegistryClient(origin, env.fetch, credential);

  let review;
  try {
    review = await client.reviewDraft(draftId);
  } catch (cause) {
    if (cause instanceof RegistryError) throw new CliError(`Could not read the draft for review (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    throw cause;
  }
  const { draft } = review;
  const revision = Number(draft.revision);
  const digest = String(draft.payload_digest);
  const kind = String(draft.kind);

  if (kind === 'project') {
    const recomputed = digestOf({ project_md: review.content, files: review.files });
    if (recomputed !== digest) {
      throw new CliError('The content the registry returned does not match its own digest. Nothing was approved.', EXIT.refused);
    }
  }
  const errors = review.issues.filter((issue) => issue.severity === 'error');
  const lines = [
    `Draft ${draftId} (${kind}), revision ${revision}, state ${String(draft.state)}`,
    `Payload digest: ${digest}${kind === 'project' ? ' (recomputed here from the content below)' : ' (computed by the registry; not recomputable here)'}`,
    review.slug ? `Public slug: ${review.slug}` : null,
    '',
    `--- ${review.content_label.replace(/^Inspect /, '')} (exactly what becomes public) ---`,
    review.content,
    ...review.files.flatMap((file) => ['', `--- Bundled file: ${file.path} ---`, file.content]),
    '--- end ---',
  ].filter((line): line is string => line !== null);
  env.io.out(lines.join('\n') + '\n');

  if (review.stale) throw new CliError('The record changed since this draft was last validated. Ask the agent to validate it again.', EXIT.refused);
  if (errors.length > 0 && !deny) {
    throw new CliError(`Blocking issues must be resolved first:\n${errors.map((issue) => `  - ${issue.message}`).join('\n')}`, EXIT.refused);
  }

  const acknowledged: string[] = [];
  if (!deny) {
    for (const code of review.warning_codes) {
      const message = [...new Set(review.issues.filter((issue) => issue.code === code).map((issue) => issue.message))].join(' ') || code;
      env.io.out(`\nLimitation (${code}): ${message}\n`);
      if (!(await env.io.ask('Acknowledge this limitation? Type "yes": '))) {
        throw new CliError('A limitation was not acknowledged. Nothing was approved.', EXIT.refused);
      }
      acknowledged.push(code);
    }
  }
  const question = deny
    ? `Deny publication of revision ${revision} (${digest})? Type "yes": `
    : `Approve exactly this artifact, revision ${revision} (${digest}), for ${Math.round(review.approval_window_seconds / 60)} minutes? Type "yes": `;
  if (!(await env.io.ask(question))) throw new CliError(deny ? 'Not denied. Nothing was recorded.' : 'Not approved. Nothing was recorded.', EXIT.refused);

  let result;
  try {
    result = await client.recordApproval(draftId, {
      draft_revision: revision,
      payload_digest: digest,
      acknowledged_warning_codes: acknowledged,
      decision: deny ? 'denied' : 'approved',
    });
  } catch (cause) {
    if (cause instanceof RegistryError) throw new CliError(`The decision was not recorded (${cause.code ?? cause.status}): ${cause.message}`, EXIT.failed);
    throw cause;
  }
  env.io.out(
    deny
      ? 'Denial recorded. Nothing can be published from this revision.\n'
      : `Approval recorded (${String(result.approval_id)}). Your agent can now publish this exact revision once, within ${Math.round(review.approval_window_seconds / 60)} minutes. Any edit invalidates it.\n`,
  );
  return EXIT.ok;
}
