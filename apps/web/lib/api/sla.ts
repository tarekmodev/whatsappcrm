import 'server-only';

import {
  SlaAlertResponseSchema,
  SlaPolicyResponseSchema,
  type CursorPage,
  type CursorPageQuery,
  type SlaAlertListQuery,
  type SlaAlertResponse,
  type SlaPolicyResponse,
  type SlaPolicyUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * The two SLA resources ADR 0006 publishes: the policy a supervisor configures,
 * and the alert a supervisor reads.
 *
 * **There is no `?recipientUserId=` on the alerts, and there must never be one.**
 * Every row names its recipient and the API adds
 * `recipient_user_id = principal.userId` on top of row-level security, so the
 * narrowing is server-side and not something a query parameter here could widen.
 * An agent may call this and gets an empty page — which is the whole of TAR-281's
 * role-scoping requirement, enforced where it counts rather than by hiding a
 * button.
 *
 * **The policies have no `POST` and no `DELETE`**, which is the API's decision
 * rather than an omission here: the seeded catch-all row is the tenant's policy,
 * and turning SLA off is `PATCH { isActive: false }` so the row running timers
 * point at stays intact. A create surface is only meaningful alongside the
 * per-priority policy UI that TAR-390 leaves out of scope.
 */

const SLA_ALERTS_PATH = '/v1/sla-alerts';
const SLA_POLICIES_PATH = '/v1/sla-policies';

/**
 * `GET /api/v1/sla-policies` — the tenant's policies, **oldest first**, so the
 * seeded `Default` row leads the page. Requires `sla:read`.
 */
export async function listSlaPolicies(
  query: CursorPageQuery,
): Promise<CursorPage<SlaPolicyResponse>> {
  const params = new URLSearchParams({ limit: String(query.limit) });

  if (query.cursor !== undefined) {
    params.set('cursor', query.cursor);
  }

  const response = await authenticatedRequest({
    method: 'GET',
    path: `${SLA_POLICIES_PATH}?${params.toString()}`,
  });

  return parseCursorPage(SlaPolicyResponseSchema, response);
}

/**
 * `PATCH /api/v1/sla-policies/{id}` — a partial edit of one policy. Requires
 * `sla:write`.
 *
 * Idempotent by construction, so it carries no `Idempotency-Key`: a `PATCH` of
 * named fields to fixed values lands the row in the same state however many
 * times it is replayed.
 *
 * **The edit reaches future tickets only.** A running timer carries the `dueAt`
 * written when it started, and nothing derives a deadline from the policy at
 * read time — so shortening a window cannot retroactively breach yesterday's
 * tickets, and lengthening one cannot un-breach them. The console says so on
 * screen rather than leaving a supervisor to find out.
 */
export async function updateSlaPolicy(
  policyId: string,
  input: SlaPolicyUpdateInput,
): Promise<SlaPolicyResponse> {
  return SlaPolicyResponseSchema.parse(
    await authenticatedRequest({
      method: 'PATCH',
      path: `${SLA_POLICIES_PATH}/${encodeURIComponent(policyId)}`,
      body: input,
    }),
  );
}

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
