import 'server-only';

import {
  SlaAlertResponseSchema,
  type CursorPage,
  type SlaAlertListQuery,
  type SlaAlertResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The SLA alert resource, per ADR 0006's endpoint surface. Two calls, which is
 * all a supervisor console needs: read what breached, and mark one seen.
 *
 * **There is no `?recipientUserId=`, and there must never be one.** Every row
 * names its recipient and the API adds `recipient_user_id = principal.userId` on
 * top of row-level security, so the narrowing is server-side and not something a
 * query parameter here could widen. An agent may call this and gets an empty
 * page — which is the whole of TAR-281's role-scoping requirement, enforced
 * where it counts rather than by hiding a button.
 *
 * `/sla-policies` is deliberately absent: TAR-26 ships the seeded default and no
 * policy-editing UI, so a client for it would be an unused surface (TAR-287
 * documents changing the window, and the story that builds the screen adds it).
 */

const SLA_ALERTS_PATH = '/v1/sla-alerts';

export async function listSlaAlerts(
  query: SlaAlertListQuery,
): Promise<CursorPage<SlaAlertResponse>> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: `${SLA_ALERTS_PATH}${toAlertQueryString(query)}`,
  });

  return parseCursorPage(SlaAlertResponseSchema, response);
}

/**
 * `POST /api/v1/sla-alerts/{id}/acknowledge` — the supervisor has seen it.
 *
 * Idempotent by contract: a second call returns the same row with the original
 * `acknowledgedAt` rather than a 409, so a double click and a retry after a
 * dropped response both land on the same answer.
 */
export async function acknowledgeSlaAlert(alertId: string): Promise<SlaAlertResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${SLA_ALERTS_PATH}/${encodeURIComponent(alertId)}/acknowledge`,
  });

  return SlaAlertResponseSchema.parse(response);
}

function toAlertQueryString(query: SlaAlertListQuery): string {
  const params = new URLSearchParams({
    limit: String(query.limit),
    unacknowledgedOnly: String(query.unacknowledgedOnly),
  });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  return `?${params.toString()}`;
}
