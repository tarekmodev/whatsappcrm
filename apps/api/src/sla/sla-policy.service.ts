import { Inject, Injectable } from '@nestjs/common';
import {
  SLA_DEFAULTS,
  type CursorPage,
  type CursorPageQuery,
  type SlaPolicyResponse,
  type SlaPolicyUpdateInput,
} from '@whatsappcrm/contracts';
import {
  encodeTimestampCursor,
  readTimestampCursor,
  resumeAfter,
  type TimestampCursor,
} from '../common/pagination/timestamp-keyset';
import type { Prisma } from '../generated/prisma/client';
import type { TicketPriority } from '../generated/prisma/enums';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';
import { resolvePolicyForPriority } from './sla-policy-resolution';
import { InvalidSlaCursorError, SlaPolicyNotFoundError } from './sla.errors';

/**
 * The tenant's SLA configuration: which policy applies to a ticket, and the CRUD
 * surface a supervisor edits it through (0006, decision 6).
 *
 * ## The row is the configuration
 *
 * 0006 rejected an `sla_first_response_minutes` column on `tenant_settings`
 * because `sla_policies` already exists with priority scoping, `is_active` and
 * the business-hours flag — a settings column would have to be migrated into it
 * the first time a tenant asks for "urgent tickets get 15 minutes". So the
 * platform default is a **seed value** written by `TenantProvisioningService`,
 * and this service never reasserts it over a tenant's own edit.
 *
 * ## Two writes, and only one of them is a create
 *
 * There is no `POST /sla-policies` at v1: the seeded row satisfies TAR-26, and a
 * create surface is only meaningful alongside the per-priority policy UI that is
 * out of scope. Turning SLA off is `PATCH { isActive: false }`, which mirrors
 * how a tenant is deactivated rather than deleted.
 *
 * The one create is `ensureResolvable` below — the lazy default for a tenant
 * provisioned before TAR-270, the same shape `ticket_counters` already uses.
 */

const POLICY_PROJECTION = {
  id: true,
  name: true,
  priority: true,
  firstResponseMinutes: true,
  resolutionMinutes: true,
  businessHoursOnly: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.SlaPolicySelect;

type PolicyRow = Prisma.SlaPolicyGetPayload<{ select: typeof POLICY_PROJECTION }>;

/** Exactly what timer creation needs: the two windows, and the id to record. */
export interface ResolvedSlaPolicy {
  readonly id: string;
  readonly firstResponseMinutes: number | null;
  readonly resolutionMinutes: number | null;
}

const RESOLUTION_PROJECTION = {
  id: true,
  priority: true,
  isActive: true,
  createdAt: true,
  firstResponseMinutes: true,
  resolutionMinutes: true,
} as const satisfies Prisma.SlaPolicySelect;

@Injectable()
export class SlaPolicyService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma) {}

  /**
   * The policy that applies to a ticket of this priority, creating the tenant's
   * default first if it has no policy at all.
   *
   * Takes a transaction client because it runs inside the caller's: resolution
   * and the timer writes that follow it have to see the same rows, and a lazy
   * create outside the transaction would be a policy row left behind by a
   * rolled-back evaluation.
   *
   * **Lazy creation is guarded by "no policy at all", not "no active policy".**
   * A tenant whose only policy is `isActive: false` has turned SLA off, and
   * creating a fresh active default for them would silently override that. The
   * same guard `TenantProvisioningService` and the backfill migration both use,
   * which is what lets all three exist without racing.
   *
   * Reads every policy the tenant has rather than filtering in SQL: the row
   * count is a handful by construction, the resolution rule is a pure function
   * that is easier to trust than three `orderBy` clauses, and the lazy-create
   * branch needs to know whether there are *any* rows.
   */
  async resolveForTicket(
    tx: Prisma.TransactionClient,
    tenantId: string,
    priority: TicketPriority,
  ): Promise<ResolvedSlaPolicy | null> {
    const policies = await tx.slaPolicy.findMany({ select: RESOLUTION_PROJECTION });

    if (policies.length === 0) {
      return await this.createDefault(tx, tenantId);
    }

    return resolvePolicyForPriority(policies, priority);
  }

  /**
   * The two windows of one named policy — what a ticket that already has timers
   * needs in order to grow the one it is missing.
   *
   * A read by id rather than a re-resolution, deliberately: a ticket keeps the
   * policy its timers were started under, so a supervisor changing the ticket's
   * priority cannot move a deadline that is already running.
   *
   * `null` when the policy has since been deleted. Nothing deletes one today —
   * there is no DELETE surface — so this is the honest answer to a state only a
   * direct database edit can produce, rather than a case worth its own error.
   */
  async findWindows(
    tx: Prisma.TransactionClient,
    policyId: string,
  ): Promise<ResolvedSlaPolicy | null> {
    return await tx.slaPolicy.findUnique({
      where: { id: policyId },
      select: { id: true, firstResponseMinutes: true, resolutionMinutes: true },
    });
  }

  /**
   * Newest-last: the seeded `Default` row is the oldest and the one a supervisor
   * is looking for, so it leads the page. Keyset paginated on
   * `(created_at ASC, id ASC)`.
   *
   * The `(tenant_id, is_active, priority)` index does not serve this sort, and
   * that is accepted rather than overlooked: a tenant has a handful of policies,
   * so the planner sorts a handful of rows. An index on `(tenant_id, created_at,
   * id)` would be a write cost on every policy edit to save a sort over five
   * rows.
   */
  async list(query: CursorPageQuery): Promise<CursorPage<SlaPolicyResponse>> {
    const cursor = readTimestampCursor(query.cursor);

    if (cursor.outcome === 'invalid') {
      throw new InvalidSlaCursorError('cursor');
    }

    const rows = await this.prisma.slaPolicy.findMany({
      where: cursor.outcome === 'cursor' ? resumeFrom(cursor.cursor) : {},
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      select: POLICY_PROJECTION,
    });

    const page = rows.slice(0, query.limit);
    const last = page.at(-1);

    return {
      items: page.map(toSlaPolicyResponse),
      nextCursor:
        rows.length > query.limit && last !== undefined
          ? encodeTimestampCursor({ at: last.createdAt, id: last.id })
          : null,
    };
  }

  async get(policyId: string): Promise<SlaPolicyResponse> {
    const policy = await this.prisma.slaPolicy.findUnique({
      where: { id: policyId },
      select: POLICY_PROJECTION,
    });

    if (policy === null) {
      throw new SlaPolicyNotFoundError(policyId);
    }

    return toSlaPolicyResponse(policy);
  }

  /**
   * A partial edit.
   *
   * `updateMany` with the id in the `WHERE` rather than `update`, so a policy in
   * another tenant is zero rows updated — which this reports as `not_found` —
   * instead of Prisma's `P2025`. RLS makes the outcome the same either way; this
   * makes the *error* the same as the one a caller gets for an id that names
   * nothing at all.
   *
   * **Editing a window changes future tickets, never past deadlines.** Running
   * timers keep the `due_at` they were started with, because that is the number
   * on the row rather than something derived from the policy at read time. A
   * supervisor shortening the window does not retroactively breach yesterday's
   * tickets, and lengthening it does not un-breach them.
   */
  async update(policyId: string, input: SlaPolicyUpdateInput): Promise<SlaPolicyResponse> {
    const { count } = await this.prisma.slaPolicy.updateMany({
      where: { id: policyId },
      data: input,
    });

    if (count === 0) {
      throw new SlaPolicyNotFoundError(policyId);
    }

    return await this.get(policyId);
  }

  /**
   * The tenant's default policy, written on first resolution.
   *
   * Reachable only for a tenant provisioned before TAR-270 whose backfill has
   * not run — both `TenantProvisioningService` and the backfill migration write
   * this row, and both are guarded the same way. Kept because the alternative is
   * a tenant whose tickets silently have no SLA at all, with nothing in the API
   * that says why.
   */
  private async createDefault(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<ResolvedSlaPolicy> {
    return await tx.slaPolicy.create({
      data: {
        tenantId,
        name: 'Default',
        // "Any priority" — the catch-all every ticket falls back to.
        priority: null,
        firstResponseMinutes: SLA_DEFAULTS.firstResponseMinutes,
        resolutionMinutes: SLA_DEFAULTS.resolutionMinutes,
        businessHoursOnly: false,
        isActive: true,
      },
      select: { id: true, firstResponseMinutes: true, resolutionMinutes: true },
    });
  }
}

export function toSlaPolicyResponse(policy: PolicyRow): SlaPolicyResponse {
  return {
    id: policy.id,
    name: policy.name,
    priority: policy.priority,
    firstResponseMinutes: policy.firstResponseMinutes,
    resolutionMinutes: policy.resolutionMinutes,
    businessHoursOnly: policy.businessHoursOnly,
    isActive: policy.isActive,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

/** The resume predicate 0002 rules, on `created_at` ascending. */
function resumeFrom(cursor: TimestampCursor): Prisma.SlaPolicyWhereInput {
  const { bound, exclude } = resumeAfter(cursor, 'asc');

  return { createdAt: bound, NOT: { createdAt: cursor.at, ...exclude } };
}
