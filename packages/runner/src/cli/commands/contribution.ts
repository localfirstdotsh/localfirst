import type { CliEnv } from '../context.js';
import { CliError, EXIT, usageError } from '../errors.js';
import { terminalSafe } from '../io.js';
import { KeychainError, registryAccount } from '../keychain.js';
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
  env.io.out(terminalSafe(
    [
      `Draft ${draftId} (${String(draft.kind)}): ${String(draft.state)}, revision ${String(draft.revision)}`,
      `Payload digest: ${String(draft.payload_digest)}`,
      `Warnings to acknowledge: ${warnings.length > 0 ? warnings.join(', ') : 'none'}`,
      approval
        ? `Approval on record for ${approval.payload_digest === draft.payload_digest ? 'this exact payload' : 'a DIFFERENT payload (stale)'}, expires ${approval.expires_at}`
        : 'No approval on record. Approving happens in the browser, after showing the exact artifact.',
      `Review in your browser: ${reviewUrl ?? '(none provided)'}`,
    ].join('\n') + '\n',
  ));

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
