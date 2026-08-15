import type { TicketPriority } from '../generated/prisma/enums';

/**
 * Which of a tenant's policies applies to a ticket (0006, decision 6).
 *
 * A pure function over rows the caller has already read, so the rule is testable
 * without a database and stated in exactly one place. The rule:
 *
 *   1. among the tenant's **active** policies,
 *   2. prefer one whose `priority` equals the ticket's,
 *   3. then the catch-all, `priority IS NULL`,
 *   4. oldest `created_at` breaking a tie, with the id breaking that.
 *
 * No active policy → no timers, and the ticket reports `not_applicable`. That is
 * a tenant decision being honoured rather than a gap: a tenant whose only policy
 * is `isActive: false` has deliberately turned SLA off, and the platform default
 * is a seed value rather than a runtime fallback that would override it.
 *
 * The tie-break is `created_at` and not "the most specific wins twice over":
 * two active policies for the same priority is a configuration a tenant can
 * reach through the API, and picking deterministically is worth more than
 * picking cleverly — the alternative is a ticket whose deadline depends on which
 * row the planner returned first.
 */
export interface ResolvablePolicy {
  readonly id: string;
  readonly priority: TicketPriority | null;
  readonly isActive: boolean;
  readonly createdAt: Date;
}

export function resolvePolicyForPriority<T extends ResolvablePolicy>(
  policies: readonly T[],
  priority: TicketPriority,
): T | null {
  const active = [...policies].filter((policy) => policy.isActive).sort(oldestFirst);

  return (
    active.find((policy) => policy.priority === priority) ??
    active.find((policy) => policy.priority === null) ??
    null
  );
}

function oldestFirst(left: ResolvablePolicy, right: ResolvablePolicy): number {
  const byCreatedAt = left.createdAt.getTime() - right.createdAt.getTime();

  // The id is the tie-breaker that makes the order total. It is a uuid v7, so
  // ordering by it is ordering by creation time to sub-millisecond precision —
  // which is the same intent as the comparison above, continued rather than
  // replaced by an arbitrary rule.
  return byCreatedAt !== 0 ? byCreatedAt : left.id.localeCompare(right.id);
}
