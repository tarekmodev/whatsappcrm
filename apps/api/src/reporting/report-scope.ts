import type { DashboardMetricsQuery, SessionPrincipal } from '@whatsappcrm/contracts';
import { Prisma } from '../generated/prisma/client';
import { assignedFilter, narrowScope } from '../rbac/visibility';

/**
 * The visibility predicate as a raw-SQL fragment, and the **only** place the
 * reporting statements say which tickets a caller may aggregate over.
 *
 * ADR 0004 calls the assigned-set rule the most re-implementable rule in the
 * codebase, and this is its first raw-SQL caller — so it is not re-implemented
 * here. `assignedScopeClause` reads its two values straight out of
 * `assignedFilter`, the same function `TicketQueryService` passes to Prisma, and
 * renders them as SQL. There is one rule and one place it is decided; this file
 * changes representation, not meaning. `report-scope.spec.ts` asserts that
 * correspondence value by value, so a change to `assignedFilter` that this file
 * failed to follow fails a test rather than widening a report.
 *
 * ## The asymmetry this creates, which is correct and worth knowing
 *
 * **Visibility reads current assignment; attribution reads recorded history.**
 * An agent's own first response on a ticket that has since been reassigned away
 * is excluded from their scoped report, because they cannot see that ticket now.
 * A supervisor's tenant-wide report still counts it, on the original responder's
 * row. Both are right, and TAR-434's documentation should say so.
 *
 * ## Every value is bound
 *
 * The principal's id and each of their team ids arrive as parameters. Nothing
 * here is string-interpolated, and the only things that look like identifiers —
 * the two column names — are literals in this file rather than anything derived
 * from a request.
 */

/** Empty fragment: a caller who may see the whole tenant needs no clause at all. */
const NO_SCOPE = Prisma.empty;

/**
 * `AND (…)`, ready to be conjoined into any of the reporting statements — or
 * nothing, for a principal holding `report:read_all` and no team filter.
 *
 * Returned as a fragment that is safe to splice unconditionally, so no statement
 * has to branch on whether it has a scope and none of them can forget one.
 */
export function reportScopeClause(
  query: Pick<DashboardMetricsQuery, 'scope' | 'assignedTeamId'>,
  principal: SessionPrincipal,
): Prisma.Sql {
  const clauses = [
    resolveReportScope(query.scope, principal) === 'assigned'
      ? assignedScopeClause(principal)
      : NO_SCOPE,
    query.assignedTeamId === undefined
      ? NO_SCOPE
      : Prisma.sql`AND "assigned_team_id" = ${query.assignedTeamId}::uuid`,
  ];

  return Prisma.join(clauses, ' ');
}

/**
 * The scope the caller actually gets, after `report:read_all` has narrowed it.
 *
 * Exported because the response echoes it — a console that asked for `all` and
 * silently received `assigned` has to be able to say so, which is the notice
 * ADR 0004 invariant 2 requires beside a narrowed view.
 *
 * `narrowScope` is the shared rule and is imported rather than re-derived. Its
 * return type carries `unassigned`, which this surface never asks for: nobody's
 * response time is measured on a ticket nobody has touched, so the query schema
 * does not offer it and the cast below is a narrowing of an input this function
 * cannot receive.
 */
export function resolveReportScope(
  requested: DashboardMetricsQuery['scope'],
  principal: SessionPrincipal,
): DashboardMetricsQuery['scope'] {
  return narrowScope(requested, principal, 'report:read_all') === 'all' ? 'all' : 'assigned';
}

/**
 * "Assigned to me, or to a team I am in" — `assignedFilter`'s two branches,
 * read out of `assignedFilter` itself rather than restated.
 *
 * An `IN (…)` list rather than `= ANY($n::uuid[])`, matching `SessionService`
 * and `SlaSweepService`: the same shape everywhere is one shape to review. The
 * empty case is why it is not written as a bare join — a teamless agent produces
 * `IN ()`, which is not valid SQL, so their team branch becomes a literal
 * `FALSE`. That is the correct predicate for them: they see their own work and
 * no team's.
 */
function assignedScopeClause(principal: SessionPrincipal): Prisma.Sql {
  const [byUser, byTeam] = assignedFilter(principal).OR;
  const teamIds = byTeam.assignedTeamId.in;

  const teamBranch =
    teamIds.length === 0
      ? Prisma.sql`FALSE`
      : Prisma.sql`"assigned_team_id" IN (${Prisma.join(
          teamIds.map((teamId) => Prisma.sql`${teamId}::uuid`),
        )})`;

  return Prisma.sql`AND ("assigned_user_id" = ${byUser.assignedUserId}::uuid OR ${teamBranch})`;
}
