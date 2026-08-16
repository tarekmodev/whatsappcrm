import 'server-only';

import { cache } from 'react';
import {
  roleHasPermission,
  type SessionPrincipal,
  type UserResponse,
} from '@whatsappcrm/contracts';
import { listUsers } from '@/lib/api/users';
import { AGENTS_PAGE_SIZE } from '@/features/people/constants';

/**
 * Who the two handoff dialogs may offer, resolved on the server so the client
 * receives a list of names rather than a directory and a copy of the rules.
 *
 * Both lists mirror a bound the API enforces. Neither is the security boundary —
 * the API refuses the same write regardless — but a picker that offers somebody
 * the server will reject is a form whose only failure mode is a round trip and a
 * refusal the agent cannot act on.
 */

export interface HandoffCandidates {
  /**
   * Who this principal may hand the ticket to (ADR 0011 decision 2).
   *
   * The caller themselves is excluded: handing a ticket to the person already
   * holding it is the no-op the API answers 200 to, and offering it would make
   * "Reassign" a button that can do nothing.
   */
  readonly teammates: readonly UserResponse[];
  /**
   * Who an escalation may name (ADR 0011 decision 3): active users holding
   * `ticket:read_all`. Requiring it is not decoration — it is what makes the
   * notification safe to send, because the recipient can already read the ticket
   * and telling them about it exposes nothing new.
   */
  readonly supervisors: readonly UserResponse[];
}

/**
 * Request-cached: the handoff card and both dialogs are one render pass, and
 * none of them should cost a second round trip. It memoises per pass only, so a
 * teammate suspended between requests is never carried over.
 */
export const loadHandoffCandidates = cache(async function loadHandoffCandidates(
  principal: SessionPrincipal,
  ticket: { assignedUserId: string | null },
): Promise<HandoffCandidates> {
  // `status: 'active'` is the API's filter, not a narrowing applied afterwards:
  // filtering a fetched page would report "nobody available" whenever the active
  // agents happened to sort past it.
  const page = await listUsers({ limit: AGENTS_PAGE_SIZE, status: 'active' });

  return {
    teammates: page.items.filter((user) => isHandoffTarget(user, principal, ticket)),
    supervisors: page.items.filter((user) => roleHasPermission(user.role, 'ticket:read_all')),
  };
});

/**
 * The teammate bound, in the console's copy of it.
 *
 * A caller holding `ticket:assign` may place a ticket anywhere, so every active
 * user is a target for them. Everybody else may hand only to somebody they share
 * a team with — "teammate" is TAR-32's own word, and it is the bound that stops
 * an agent parking work on a team they have nothing to do with.
 */
function isHandoffTarget(
  user: UserResponse,
  principal: SessionPrincipal,
  ticket: { assignedUserId: string | null },
): boolean {
  if (user.id === principal.userId || user.id === ticket.assignedUserId) {
    return false;
  }

  if (roleHasPermission(principal.role, 'ticket:assign')) {
    return true;
  }

  return user.teamIds.some((teamId) => principal.teamIds.includes(teamId));
}
