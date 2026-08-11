import 'server-only';

import { cache } from 'react';
import { listTeams } from '@/lib/api/teams';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE } from '@/features/people/constants';

/**
 * Display names for the ids the inbox renders: assignees, message senders, note
 * authors and the people a note mentions.
 *
 * One read shared by the list and the thread — they sit in separate Suspense
 * boundaries and would otherwise each fetch the same two pages. `cache`
 * deduplicates per render pass only, so a name changed between requests is never
 * carried over.
 *
 * `user:read` and `team:read` are granted to every role, so an agent can resolve
 * the names on their own rows too.
 */

export interface Directory {
  readonly userNames: ReadonlyMap<string, string>;
  readonly teamNames: ReadonlyMap<string, string>;
}

export const loadDirectory = cache(async (): Promise<Directory> => {
  const [users, teams] = await Promise.all([listUsers({ limit: AGENTS_PAGE_SIZE }), listTeams()]);

  return {
    userNames: new Map(users.items.map((user) => [user.id, user.displayName])),
    teamNames: new Map(teams.items.map((team) => [team.id, team.name])),
  };
});

/** A name, or `null` when the id names nobody this principal can see. */
export function nameFor(names: ReadonlyMap<string, string>, id: string | null): string | null {
  return id === null ? null : (names.get(id) ?? null);
}
