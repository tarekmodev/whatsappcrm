import 'server-only';

import type { TeamResponse, TenantRole, UserResponse } from '@whatsappcrm/contracts';
import { listUsers } from '@/lib/api/users';
import { listTeams } from '@/lib/api/teams';
import { AGENTS_PAGE_SIZE } from './constants';

/**
 * Server-side reads for the People surface. Both lists come from the API in one
 * pass so the client never has to fetch, and so tenant scoping is decided
 * server-side where the session lives.
 */

export interface PeopleData {
  users: readonly UserResponse[];
  teams: readonly TeamResponse[];
}

export interface PeopleFilters {
  role?: TenantRole;
  q?: string;
}

export async function loadPeople(filters: PeopleFilters): Promise<PeopleData> {
  // Independent requests: awaiting them in sequence would double the page's TTFB
  // for no reason.
  const [users, teams] = await Promise.all([
    listUsers({ limit: AGENTS_PAGE_SIZE, role: filters.role, q: filters.q }),
    listTeams(),
  ]);

  return { users: users.items, teams: teams.items };
}
