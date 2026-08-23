import 'server-only';

import {
  AssignmentSettingsResponseSchema,
  type AssignmentSettingsResponse,
} from '@whatsappcrm/contracts';
import { authenticatedRequest } from '@/lib/api/authenticated';

/**
 * `GET /api/v1/assignment-settings` — the workspace-wide default concurrent
 * ticket cap (ADR 0008 decision 4, TAR-384).
 *
 * The **per-agent** override is not here and is not meant to be: it is a column
 * on `users`, so it is read through `assignmentCapacity` on the people list and
 * written through `PATCH /v1/users/{id}` in `users.ts`. One column, one write
 * path. This resource answers the other question — what an agent with no
 * override inherits.
 */

const ASSIGNMENT_SETTINGS_PATH = '/v1/assignment-settings';

export async function getAssignmentSettings(): Promise<AssignmentSettingsResponse> {
  const response = await authenticatedRequest({
    method: 'GET',
    path: ASSIGNMENT_SETTINGS_PATH,
  });

  return AssignmentSettingsResponseSchema.parse(response);
}
