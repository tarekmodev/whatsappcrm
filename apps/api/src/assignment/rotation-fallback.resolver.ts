import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSIGNMENT_POLICY,
  type FallbackAssignmentDecision,
  type FallbackAssignmentReason,
  type FallbackAssignmentRequest,
  type FallbackAssignmentResolver,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { UserRole, UserStatus } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { uuidV7 } from '../prisma/uuid-v7';
import { FallbackAssignmentTenantMismatchError } from './assignment.errors';

/** One eligible agent, with the two numbers that decide whether they can take the ticket. */
interface CandidateRow {
  readonly userId: string;
  /** `coalesce(users.max_concurrent_tickets, tenant_settings.default_max_concurrent_tickets)`. */
  readonly cap: number;
  /** Tickets currently assigned to them in an active status. */
  readonly activeCount: number;
}

/**
 * Rotation: who takes the next ticket nobody's rule claimed.
 *
 * The implementation of `FallbackAssignmentResolver` from
 * `@whatsappcrm/contracts` — TAR-23's round-robin/load-based assignment,
 * specified in `docs/architecture/0008-assignment-rotation-and-workload.md`
 * behind the seam `0007-routing-rules-and-assignment-fallback.md` published.
 * TAR-288's rule engine reaches it through the
 * `FALLBACK_ASSIGNMENT_RESOLVER` token when no rule matched.
 *
 * ## The selection rule, in one sentence
 *
 * Of the agents who are active, available, recently seen and under their cap,
 * take the least loaded; break ties by whoever comes after the rotation cursor;
 * break what remains by `users.id`, which is uuid v7 and therefore join order.
 *
 * That composition is the whole design and it is worth knowing why it is not two
 * modes with a switch: with everyone at equal load — the ordinary morning — the
 * first key is a no-op and this *is* round-robin, which is what TAR-23's
 * acceptance criterion literally asks for. The moment loads diverge, because one
 * agent's tickets are slow to resolve, work goes to whoever has least. Neither
 * mode needs a flag, and no configuration chooses between them.
 *
 * ## What it does not do
 *
 * **It decides; it does not assign.** Nothing here writes to `tickets`. The
 * caller performs the compare-and-set that records the assignment, because that
 * write also appends the ticket event and is the one place a supervisor's manual
 * assignment must be allowed to win (0007 decision 5). The single row this class
 * does write is the rotation cursor.
 *
 * **It never reports failure as a decision.** "Nobody was eligible" is an
 * answer — a `no_eligible_agent` decision naming which of the three reasons it
 * was, because a supervisor has to see and act on it. A database fault, or a
 * call made outside tenant scope, throws; the routing job fails and retries.
 *
 * ## The cap is exact at worker concurrency 1, and only there
 *
 * The resolver decides and the caller writes, so no lock spans the two: two
 * routing jobs running at the same instant can both see an agent at `cap - 1`
 * and both assign, putting that agent one over. The `assignment` worker
 * therefore runs at `concurrency: 1` — the repo default, and the same call
 * `TicketQueueRunner` already made. Raising it, or running two API processes,
 * makes the cap approximate: overshoot bounded by concurrent routing workers
 * minus one, per agent, self-correcting on the next ticket. If it has to stay
 * exact at that point the fix is a revision to 0007 decision 5 — move the
 * compare-and-set in here, or have the caller's `UPDATE` carry the cap as an
 * extra predicate — not a patch to this class.
 */
@Injectable()
export class RotationFallbackResolver implements FallbackAssignmentResolver {
  private readonly logger = new Logger(RotationFallbackResolver.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  async resolveFallbackAssignment(
    request: FallbackAssignmentRequest,
  ): Promise<FallbackAssignmentDecision> {
    const tenantId = this.tenantContext.requireTenantId();

    if (request.tenantId !== tenantId) {
      throw new FallbackAssignmentTenantMismatchError(request.tenantId, tenantId);
    }

    const cursor = await this.readCursor(tenantId, request.teamId);
    const candidates = await this.readCandidates(tenantId, request.teamId, cursor);
    const chosen = candidates.find((candidate) => candidate.activeCount < candidate.cap);

    if (chosen === undefined) {
      const reason = await this.explainEmptyRotation(tenantId, request.teamId, candidates);

      // No PII: ids, an enum and a count. The rate of this line per tenant is
      // the product signal 0008 asks to monitor — a tenant deferring
      // persistently is understaffed or mis-capped.
      this.logger.log(
        `Rotation had nobody for ticket ${request.ticketId} in scope ${describeScope(request.teamId)}: ` +
          `${reason} (${candidates.length} eligible candidate(s) considered)`,
      );

      return { outcome: 'no_eligible_agent', userId: null, teamId: request.teamId, reason };
    }

    await this.advanceCursor(tenantId, request.teamId, chosen.userId);

    return { outcome: 'assigned', userId: chosen.userId, teamId: request.teamId, reason: null };
  }

  /**
   * Where the ring stopped for this scope, or `null` for a scope that has never
   * assigned.
   *
   * `null` needs no special case downstream: it makes the `>` comparison in the
   * ORDER BY yield NULL, the `coalesce` turns that into `false` for every row,
   * and the ring starts at the lowest id.
   *
   * `findFirst` rather than `findUnique`: `teamId` is nullable and `null` is a
   * real scope — the tenant pool — so this has to compile to `team_id IS NULL`
   * rather than to `team_id = NULL`, which matches nothing. Prisma's compound
   * unique input cannot express that; a plain filter can.
   */
  private async readCursor(tenantId: string, teamId: string | null): Promise<string | null> {
    const state = await this.prisma.assignmentState.findFirst({
      where: { tenantId, teamId },
      select: { lastAssignedUserId: true },
    });

    return state?.lastAssignedUserId ?? null;
  }

  /**
   * Every eligible agent in the scope, in the order rotation would take them.
   *
   * One statement returning the whole candidate set with its load rather than
   * just the winner, because when nobody is eligible the same rows decide the
   * reason — and a second query to work that out would be a second query on the
   * failure path.
   *
   * **Eligibility is four predicates, and the third is not in TAR-23's text.**
   * `status = 'active'` and the cap are the two it names; `availability` is the
   * explicit signal `users.ts` already documents as the thing rotation skips on;
   * `last_seen_at` inside the presence window is the addition. Without it an
   * agent who sets `available` on Monday and shuts the laptop keeps taking a
   * share of every ticket into a black hole — the worse failure, because the
   * tickets *look* assigned. A `last_seen_at` of NULL fails the comparison and
   * is excluded, which is the right answer for someone who has never been seen.
   *
   * **`tenant_id` is supplied explicitly on every predicate** even though RLS
   * filters anyway (0003, rule 3). Here it is also what makes the planner use
   * the `(tenant_id, ...)` composite indexes — `users (tenant_id, status)` for
   * the scan, `tickets_tenant_assigned_user_queue_idx` for each load count.
   *
   * The active-status list is written out rather than interpolated from
   * `TICKET_ACTIVE_STATUSES`: it is a literal in the SQL exactly as it is in
   * `TicketLinkerService.create`, and `rotation-fallback.resolver.spec.ts`
   * asserts the constant still says the same thing so a widening of one cannot
   * silently pass the other by.
   */
  private async readCandidates(
    tenantId: string,
    teamId: string | null,
    cursor: string | null,
  ): Promise<CandidateRow[]> {
    return this.prisma.$queryRaw<CandidateRow[]>`
      WITH cap_default AS (
        -- coalesce, not a join: TAR-50's provisioning does not guarantee a
        -- tenant_settings row, and a missing one must not stop routing.
        SELECT coalesce(
          (SELECT ts.default_max_concurrent_tickets
             FROM tenant_settings ts
            WHERE ts.tenant_id = ${tenantId}::uuid),
          ${ASSIGNMENT_POLICY.defaultMaxConcurrentTickets}::int
        ) AS value
      ),
      candidates AS (
        SELECT u.id,
               coalesce(u.max_concurrent_tickets, d.value) AS cap
          FROM users u
          CROSS JOIN cap_default d
          LEFT JOIN team_members tm
                 ON tm.tenant_id = u.tenant_id
                AND tm.user_id = u.id
                AND tm.team_id = ${teamId}::uuid
         WHERE u.tenant_id = ${tenantId}::uuid
           AND u.status = 'active'
           AND u.availability = 'available'
           AND u.last_seen_at > now() - (${ASSIGNMENT_POLICY.presenceWindowMs}::int * interval '1 millisecond')
           -- A team scope is its members, whatever their role. The tenant pool
           -- is agents only: a supervisor holds every agent permission, so
           -- without this every tenant's supervisor is silently placed in the
           -- rotation and starts receiving customer tickets between doing their
           -- own job.
           AND CASE WHEN ${teamId}::uuid IS NULL THEN u.role = 'agent' ELSE tm.id IS NOT NULL END
      )
      SELECT c.id AS "userId",
             c.cap::int AS "cap",
             (SELECT count(*)::int
                FROM tickets t
               WHERE t.tenant_id = ${tenantId}::uuid
                 AND t.assigned_user_id = c.id
                 AND t.status IN ('open', 'pending')) AS "activeCount"
        FROM candidates c
       ORDER BY "activeCount" ASC,                            -- load-based
                coalesce(c.id > ${cursor}::uuid, false) DESC, -- round-robin, with wraparound
                c.id ASC                                      -- a total order, always
    `;
  }

  /**
   * Which of the three reasons the caller should record, in the precedence 0008
   * fixes: first match wins.
   *
   *   1. any present, available candidate exists → `all_at_capacity`
   *   2. any active user is in the scope         → `none_available`
   *   3. otherwise                               → `no_candidate_pool`
   *
   * `all_at_capacity` wins the first tie because it is the state that resolves
   * itself as tickets close, and therefore the more useful thing to tell
   * somebody staring at the queue. The second and third are split because
   * "nobody is online" and "nobody was ever put in this team" need different
   * people to act — a staffing problem against a configuration one — and
   * collapsing them sends a supervisor hunting for absent colleagues who were
   * never configured.
   *
   * Reaching predicate 2 costs one extra count, and only on the failure path:
   * a non-empty candidate set answers the question without a second query.
   */
  private async explainEmptyRotation(
    tenantId: string,
    teamId: string | null,
    candidates: readonly CandidateRow[],
  ): Promise<FallbackAssignmentReason> {
    if (candidates.length > 0) {
      return 'all_at_capacity';
    }

    // Deliberately ignores `availability` and `last_seen_at` — this asks whether
    // the scope holds anyone who *could* ever be a candidate, which is what
    // separates a staffing problem from a configuration one.
    const inScope = await this.prisma.user.count({
      where: {
        tenantId,
        status: UserStatus.active,
        ...(teamId === null
          ? { role: UserRole.agent }
          : { teamMemberships: { some: { tenantId, teamId } } }),
      },
    });

    return inScope > 0 ? 'none_available' : 'no_candidate_pool';
  }

  /**
   * Moves the ring on, so equally-loaded agents take turns.
   *
   * **The cursor is a fairness hint, not a ledger**, and the consequence is
   * worth stating rather than hiding: this commits before the caller's
   * compare-and-set, which can then lose to a supervisor assigning the ticket by
   * hand in the intervening milliseconds. The cursor would then name somebody
   * who was never actually given that ticket, and the next assignment starts one
   * place further round the ring than it strictly should. That is invisible at
   * any timescale a fairness property is measured over, and the load key
   * corrects for it on the next ticket anyway (0008 decision 5, risk 7).
   *
   * Raw SQL because the Prisma client cannot express either half. `upsert` needs
   * a compound unique input, and a nullable `teamId` in one compiles to
   * `team_id = NULL`, which matches nothing — so the tenant pool would insert a
   * second cursor row every time. `ON CONFLICT (tenant_id, team_id)` resolves
   * against `assignment_state_tenant_scope_key`, which is `NULLS NOT DISTINCT`
   * and therefore treats the pool as the one scope it is.
   *
   * `id` and `updated_at` are supplied here because neither default reaches a
   * raw statement: `@default(uuid(7))` and `@updatedAt` are both client-side.
   */
  private async advanceCursor(
    tenantId: string,
    teamId: string | null,
    userId: string,
  ): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO assignment_state (id, tenant_id, team_id, last_assigned_user_id, updated_at)
      VALUES (${uuidV7()}::uuid, ${tenantId}::uuid, ${teamId}::uuid, ${userId}::uuid, now())
      ON CONFLICT (tenant_id, team_id) DO UPDATE
        SET last_assigned_user_id = EXCLUDED.last_assigned_user_id,
            updated_at = now()
    `;
  }
}

/** The tenant pool is a scope, not a missing value, and reads as one in a log line. */
function describeScope(teamId: string | null): string {
  return teamId === null ? 'the tenant pool' : `team ${teamId}`;
}
