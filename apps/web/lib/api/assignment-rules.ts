import 'server-only';

import {
  AssignmentRuleListResponseSchema,
  AssignmentRuleResponseSchema,
  type AssignmentRuleCreateInput,
  type AssignmentRuleReorderInput,
  type AssignmentRuleResponse,
  type AssignmentRuleUpdateInput,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `/api/v1/assignment-rules`, per ADR 0007's REST surface (amendment 7 to 0002).
 *
 * The list deliberately does not paginate and returns a plain array rather than a
 * `CursorPage`: 0007 fixes `nextCursor` at `null` because the set is bounded by
 * `ROUTING_RULE_LIMITS.rulesPerTenant`, so handing callers a cursor they can never
 * use would only invite a paging loop that never runs.
 *
 * Tenant scoping is the API's, from the session cookie. There is no tenant
 * parameter here to get wrong.
 */

const ASSIGNMENT_RULES_PATH = '/v1/assignment-rules';

export async function listAssignmentRules(): Promise<readonly AssignmentRuleResponse[]> {
  const response = await authenticatedRequest({ method: 'GET', path: ASSIGNMENT_RULES_PATH });

  return AssignmentRuleListResponseSchema.parse(response).items;
}

export async function createAssignmentRule(
  input: AssignmentRuleCreateInput,
): Promise<AssignmentRuleResponse> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: ASSIGNMENT_RULES_PATH,
    body: input,
  });

  return AssignmentRuleResponseSchema.parse(response);
}

export async function updateAssignmentRule(
  id: string,
  input: AssignmentRuleUpdateInput,
): Promise<AssignmentRuleResponse> {
  const response = await authenticatedRequest({
    method: 'PATCH',
    path: `${ASSIGNMENT_RULES_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return AssignmentRuleResponseSchema.parse(response);
}

export async function deleteAssignmentRule(id: string): Promise<void> {
  await authenticatedRequest({
    method: 'DELETE',
    path: `${ASSIGNMENT_RULES_PATH}/${encodeURIComponent(id)}`,
  });
}

/**
 * Rewrites `position` across the tenant's whole rule set in one transaction.
 *
 * The payload is the complete set rather than a delta, which is also this
 * endpoint's optimistic concurrency: a set that is not exactly the tenant's
 * current one means another supervisor added or removed a rule since this page
 * loaded, and the API answers `conflict` instead of reordering half of it.
 */
export async function reorderAssignmentRules(
  input: AssignmentRuleReorderInput,
): Promise<readonly AssignmentRuleResponse[]> {
  const response = await authenticatedRequest({
    method: 'POST',
    path: `${ASSIGNMENT_RULES_PATH}/reorder`,
    body: input,
  });

  return AssignmentRuleListResponseSchema.parse(response).items;
}
