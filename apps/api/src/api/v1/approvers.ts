/**
 * Linking a machine so it can record a person's publication decision
 * (BACKEND_PRD section 10.4). The machine starts and redeems a link; only a
 * signed-in browser session can approve one or manage the resulting devices.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { config } from '../../config.js';
import type { AppContext, AppEnv } from '../../http/context.js';
import { ApiError } from '../../http/errors.js';
import { success } from '../../http/middleware.js';
import { bucketForActor, consumeLimit } from '../../http/rate-limit.js';
import { requireHuman } from '../../auth/guards.js';
import {
  CREDENTIAL_TTL_SECONDS,
  LINK_POLL_INTERVAL_SECONDS,
  LINK_TTL_SECONDS,
  decideLink,
  formatUserCode,
  listApproverDevices,
  redeemLink,
  revokeApproverDevice,
  startLink,
} from '../../services/approvers.js';

const startSchema = z.object({ client_label: z.string().max(200).default('') }).strict();
const redeemSchema = z.object({ poll_secret: z.string().min(20).max(200) }).strict();
const decisionSchema = z
  .object({ user_code: z.string().min(4).max(20), decision: z.enum(['approved', 'denied']) })
  .strict();

async function body<T>(c: AppContext, schema: z.ZodType<T>): Promise<T> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw ApiError.badRequest('A JSON request body is required.');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw ApiError.badRequest('The request body is not valid.');
  return parsed.data;
}

export const approverLinkRoutes = new Hono<AppEnv>();

approverLinkRoutes.post('/', async (c) => {
  await consumeLimit(bucketForActor(c.get('actor'), c.get('clientIp')), {
    name: 'approver_link_start',
    max: 10,
    windowSeconds: 3600,
  });
  const { client_label } = await body(c, startSchema);
  const link = await startLink(client_label);
  const code = formatUserCode(link.userCode);
  return c.json(
    success(
      {
        link_id: link.linkId,
        user_code: code,
        poll_secret: link.pollSecret,
        verification_url: `${config().websiteUrl}/account/devices?code=${code}`,
        expires_in: LINK_TTL_SECONDS,
        interval: LINK_POLL_INTERVAL_SECONDS,
      },
      c.get('requestId'),
    ),
    201,
  );
});

approverLinkRoutes.post('/decision', requireHuman(), async (c) => {
  const { user_code, decision } = await body(c, decisionSchema);
  await decideLink(c.get('actor'), user_code, decision);
  return c.json(success({ decision }, c.get('requestId')));
});

approverLinkRoutes.post('/:link_id/token', async (c) => {
  await consumeLimit(bucketForActor(c.get('actor'), c.get('clientIp')), {
    name: 'approver_link_poll',
    max: 120,
    windowSeconds: 60,
  });
  const { poll_secret } = await body(c, redeemSchema);
  const linkId = c.req.param('link_id');
  if (!/^[0-9a-f-]{36}$/.test(linkId)) throw ApiError.notFound();
  const result = await redeemLink(linkId, poll_secret);
  if (result.status === 'pending') {
    return c.json(success({ status: 'authorization_pending', interval: LINK_POLL_INTERVAL_SECONDS }, c.get('requestId')), 202);
  }
  if (result.status === 'gone') {
    throw new ApiError({
      code: 'INVALID_LIFECYCLE',
      status: 410,
      message:
        result.reason === 'denied'
          ? 'The request was denied in the browser.'
          : result.reason === 'expired'
            ? 'The request expired. Start again.'
            : 'This request is no longer available. Start again.',
      details: { reason: result.reason },
    });
  }
  c.header('Cache-Control', 'no-store');
  return c.json(
    success(
      {
        status: 'issued',
        credential: result.credential,
        credential_id: result.credentialId,
        label: result.label,
        expires_at: result.expiresAt.toISOString(),
        lifetime_seconds: CREDENTIAL_TTL_SECONDS,
      },
      c.get('requestId'),
    ),
  );
});

export const approverDeviceRoutes = new Hono<AppEnv>();

approverDeviceRoutes.get('/', requireHuman(), async (c) => {
  const actor = c.get('actor');
  if (actor.kind === 'anonymous') throw ApiError.unauthenticated();
  const devices = await listApproverDevices(actor.userId);
  return c.json(
    success(
      devices.map((device) => ({
        device_id: device.id,
        label: device.label,
        created_at: device.createdAt.toISOString(),
        expires_at: device.expiresAt.toISOString(),
        last_used_at: device.lastUsedAt?.toISOString() ?? null,
      })),
      c.get('requestId'),
    ),
  );
});

approverDeviceRoutes.delete('/:device_id', requireHuman(), async (c) => {
  const id = c.req.param('device_id');
  if (!/^[0-9a-f-]{36}$/.test(id)) throw ApiError.notFound();
  await revokeApproverDevice(c.get('actor'), id);
  return c.body(null, 204);
});
