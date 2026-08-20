import { UserStatus } from '../generated/prisma/enums';
import type { Prisma } from '../generated/prisma/client';

/**
 * Which users a workflow may name — **one predicate, two readers**.
 *
 * The read that decides whether a reference resolves (and therefore whether a
 * workflow may be armed) and the read the executor makes when it actually
 * reassigns or notifies have to be the same question. When they were two
 * separate copies they disagreed, and the disagreement was a loop rather than a
 * one-off failure:
 *
 *   1. An admin removes a user. `users.service.ts` disarms every workflow naming
 *      them (`broken_reason = 'reference_removed'`) and drops the reference rows.
 *   2. Removal is a **status change, not a delete** — the row survives with
 *      `status = 'removed'` — so a name lookup with no status filter still finds
 *      it. The reference reads `exists: true`, `broken_reason` is cleared on the
 *      next write, and the console offers Enable.
 *   3. The supervisor enables it. The first ticket reaches
 *      `WorkflowActionExecutor`, which *does* filter on `active`, finds nobody,
 *      and records `reference_missing` — which auto-deactivates the workflow.
 *   4. The console shows it broken again, the supervisor repairs and re-arms,
 *      and it repeats.
 *
 * `active` is the right side of that disagreement, on the reasoning
 * `TicketCommandService.assign` already states: a removed account cannot answer,
 * a suspended one has had its access cut, and an `invited` user has no session
 * to open the ticket with. A workflow that escalates to any of them looks like a
 * fix and is a second deferral.
 *
 * So a reference to a non-active user resolves to **nothing**, which makes it
 * `exists: false` in the response, keeps `broken_reason` standing, and refuses
 * arming with `workflow_reference_broken` naming the field — the outcome 0009
 * decision 6 describes, reached before a ticket is touched rather than after.
 *
 * Tags and teams need no equivalent: neither carries a status, so for them
 * "in this tenant" is the whole of "referenceable".
 */
export const REFERENCEABLE_USER = {
  status: UserStatus.active,
} as const satisfies Prisma.UserWhereInput;
