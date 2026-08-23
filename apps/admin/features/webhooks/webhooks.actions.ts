'use server';

import {
  AdminWebhookEventParamsSchema,
  type AdminWebhookEventReplayResponse,
} from '@whatsappcrm/contracts';
import type { ActionResult } from '@/lib/actions/result';
import { runAdminAction } from '~/lib/actions/run-admin-action';
import { replayWebhookEvent } from '~/lib/api/admin';

/**
 * Resets one parked event.
 *
 * Nothing to revalidate: the screen holds no server-read list — there is no
 * endpoint that lists parked events — so the result the operator needs is the
 * response itself, which this returns.
 */
export async function replayWebhookEventAction(
  input: unknown,
): Promise<ActionResult<AdminWebhookEventReplayResponse>> {
  return runAdminAction({
    parser: AdminWebhookEventParamsSchema,
    input,
    perform: async ({ webhookEventId }) => await replayWebhookEvent(webhookEventId),
    revalidate: null,
    label: 'Replay webhook event',
  });
}
