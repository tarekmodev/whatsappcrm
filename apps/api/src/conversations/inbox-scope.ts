import type { ConversationListQuery, SessionPrincipal } from '@whatsappcrm/contracts';
import type { Prisma } from '../generated/prisma/client';
import { assignedFilter, sharedInboxFilter, unclaimedFilter } from '../rbac/visibility';

/**
 * `ConversationListQuery.scope` as a `where` fragment.
 *
 * The three scopes answer three different questions, and only the third
 * involves the permission matrix at all:
 *
 *   * **`assigned`** — my work: assigned to me, or to a team I am in. A filter
 *     the caller chose, so it means the same thing for an agent and for a
 *     supervisor. This is the default, and it is what an agent opens the inbox
 *     to.
 *   * **`unassigned`** — the shared pool: threads nobody has claimed. Open to
 *     every principal, because that is what a shared inbox *is* — a customer
 *     writes in and the first agent free picks it up. Claiming is
 *     `POST /conversations/{id}/assign`, and it is what takes a thread out of
 *     this scope.
 *   * **`all`** — everything I may see. For a principal holding
 *     `conversation:read_all` that is the whole tenant, and the query carries no
 *     scope clause. For anyone else it narrows to their own work plus the
 *     unclaimed pool, rather than being rejected: a supervisor's shared inbox
 *     URL then renders for an agent with less in it, which is the "narrow, never
 *     reject" rule `visibility.ts` states.
 *
 * ## Why `unassigned` is open here and closed in `visibility.ts`
 *
 * `narrowScope` requires `_all` for `unassigned`, and its comment argues that
 * widening it "would expose the whole tenant backlog". That reasoning is about
 * tickets, where the backlog is work somebody has already triaged into a queue.
 * A conversation is not created by an agent — it is created by a customer
 * writing in — so an unclaimed one has, by construction, nobody it is visible
 * to. `isVisibleOrUnclaimed` is where that difference is written down; this file
 * is the query side of the same rule, and the two are asserted against each
 * other rather than restated: every scope here is a subset of what
 * `isVisibleOrUnclaimed` admits.
 */
export function inboxScopeFilter(
  scope: ConversationListQuery['scope'],
  principal: SessionPrincipal,
): Prisma.ConversationWhereInput | null {
  switch (scope) {
    case 'assigned':
      return assignedFilter(principal);
    case 'unassigned':
      return unclaimedFilter();
    case 'all':
      return sharedInboxFilter(principal, 'conversation:read_all');
  }
}
