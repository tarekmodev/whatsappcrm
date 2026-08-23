import {
  ASSIGNMENT_POLICY,
  TICKET_ACTIVE_STATUSES,
  type AgentCapacity,
} from '@whatsappcrm/contracts';
import type { TenantPrisma } from '../prisma/prisma.tokens';

/**
 * The two reads an `AgentCapacity` is assembled from, and the coalesce that
 * turns them into an effective cap (TAR-384, 0008 amendment 4).
 *
 * Free functions in `people/` rather than a provider in `AssignmentModule`,
 * following 0009's ruling on `supervisor-recipients.ts`: two modules need this
 * and a pure function should not live in one of them. `UsersService` (L3) could
 * not import from `AssignmentModule` (L4) anyway — that is the upward import
 * 0002's layering forbids — while `AssignmentSettingsService` reaching down into
 * `people/` is the allowed direction.
 *
 * Every function takes the client rather than injecting one, so a caller decides
 * where the read sits. `TenantPrisma` and not a transaction client on purpose:
 * both reads are reads, neither belongs inside a write transaction holding a
 * connection open, and the GUC the RLS policies need is set per statement.
 */

/**
 * The tenant-wide default, with the same fallback the resolver already applies
 * at `rotation-fallback.resolver.ts:170`.
 *
 * A missing `tenant_settings` row is not an error: TAR-50's provisioning writes
 * one for every tenant it creates, but a legacy tenant may predate that and must
 * still route. `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets` is the built-in
 * both this and the resolver coalesce to, so the number a supervisor is shown is
 * the number rotation will use.
 */
export async function readTenantCapacityDefault(
  db: TenantPrisma,
  tenantId: string,
): Promise<number> {
  const settings = await db.tenantSettings.findUnique({
    where: { tenantId },
    select: { defaultMaxConcurrentTickets: true },
  });

  return settings?.defaultMaxConcurrentTickets ?? ASSIGNMENT_POLICY.defaultMaxConcurrentTickets;
}

/**
 * How many active tickets each of `userIds` holds.
 *
 * **One aggregate, never one query per user.** A `GROUP BY assigned_user_id` over
 * a bounded id set, served by `tickets_tenant_assigned_user_queue_idx`
 * (`(tenant_id, assigned_user_id, status, …)`) — every column the predicate and
 * the grouping need is in that index. Callers bound the set: a people page is
 * `CursorPageQuerySchema.limit`, max 100.
 *
 * Users holding nothing are absent from the result, so callers read through
 * {@link toAgentCapacity} rather than indexing the map directly.
 */
export async function readActiveTicketCounts(
  db: TenantPrisma,
  tenantId: string,
  userIds: readonly string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const grouped = await db.ticket.groupBy({
    by: ['assignedUserId'],
    where: {
      tenantId,
      assignedUserId: { in: [...userIds] },
      status: { in: [...TICKET_ACTIVE_STATUSES] },
    },
    _count: { _all: true },
  });

  return new Map(
    grouped.flatMap((row) =>
      // `assignedUserId` is nullable on the model and cannot be null here — it
      // is in the `in` predicate. Narrowed rather than asserted away.
      row.assignedUserId === null ? [] : [[row.assignedUserId, row._count._all] as const],
    ),
  );
}

/**
 * The published shape, from the three numbers that make it up.
 *
 * The coalesce lives here and nowhere else: a client recomputing "override, or
 * else the tenant default" would be a second implementation of a policy rule,
 * and one of the two would eventually disagree with the resolver.
 */
export function toAgentCapacity(
  maxConcurrentTickets: number | null,
  tenantDefault: number,
  activeTicketCount: number,
): AgentCapacity {
  return {
    maxConcurrentTickets,
    effectiveMaxConcurrentTickets: maxConcurrentTickets ?? tenantDefault,
    activeTicketCount,
  };
}
