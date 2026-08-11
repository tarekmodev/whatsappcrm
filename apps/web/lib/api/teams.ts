import 'server-only';

import {
  TeamResponseSchema,
  type CursorPage,
  type TeamCreateInput,
  type TeamResponse,
  type TeamUpdateInput,
} from '@whatsappcrm/contracts';
import { apiRequest } from '@/lib/api/http';
import { parseCursorPage } from '@/lib/api/parse';

/**
 * `GET/POST /api/v1/teams` per TAR-39's endpoint table, plus
 * `PATCH /api/v1/teams/{id}` for membership changes after creation.
 *
 * That PATCH is the one place this module goes beyond the published table: the
 * contract already exports `TeamUpdateInputSchema`, but the endpoint list omits
 * the route. Without it a supervisor holding `team:write` could create a team and
 * then never change who is in it, because `PATCH /v1/users/{id}` needs
 * admin-only `user:update`. Raised with TAR-81 on the issue.
 */

const TEAMS_PATH = '/v1/teams';
const TEAMS_PAGE_SIZE = 100;

export async function listTeams(): Promise<CursorPage<TeamResponse>> {
  const response = await apiRequest({
    method: 'GET',
    path: `${TEAMS_PATH}?limit=${String(TEAMS_PAGE_SIZE)}`,
  });

  return parseCursorPage(TeamResponseSchema, response);
}

export async function createTeam(input: TeamCreateInput): Promise<TeamResponse> {
  const response = await apiRequest({ method: 'POST', path: TEAMS_PATH, body: input });

  return TeamResponseSchema.parse(response);
}

export async function updateTeam(id: string, input: TeamUpdateInput): Promise<TeamResponse> {
  const response = await apiRequest({
    method: 'PATCH',
    path: `${TEAMS_PATH}/${encodeURIComponent(id)}`,
    body: input,
  });

  return TeamResponseSchema.parse(response);
}
