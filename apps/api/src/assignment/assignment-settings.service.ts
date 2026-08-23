import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  ASSIGNMENT_POLICY,
  type AssignmentSettingsResponse,
  type AssignmentSettingsUpdateInput,
  type OwnAssignmentCapacityResponse,
} from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../audit/audit.actions';
import { AuditService } from '../audit/audit.service';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import {
  readActiveTicketCounts,
  readTenantCapacityDefault,
  toAgentCapacity,
} from '../people/agent-capacity';
import { TENANT_PRISMA, type TenantPrisma } from '../prisma/prisma.tokens';

/**
 * The tenant-wide concurrent-ticket cap, and an agent's read of their own
 * (TAR-384, 0008 amendment 4).
 *
 * Everything here runs on `TenantPrisma`, so every statement carries the
 * `app.tenant_id` GUC and is filtered by TAR-48's row-level security. There is
 * no tenant parameter anywhere in this file, and no id parameter on the `me`
 * path — "own value only" is the shape of the query rather than a check
 * somebody has to remember.
 *
 * **Nothing here caches.** A `PATCH` lands in Postgres and the very next routing
 * job reads the new number: `RotationFallbackResolver.readCandidates` computes
 * `coalesce(u.max_concurrent_tickets, d.value)` in one raw statement per job,
 * with no memoisation between it and the column. That is the parent story's
 * third acceptance criterion — no restart, no invalidation — and it holds
 * because nothing was added, so the way to break it is to add a cache here.
 */
@Injectable()
export class AssignmentSettingsService {
  private readonly logger = new Logger(AssignmentSettingsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: TenantPrisma,
    private readonly tenantContext: TenantContextService,
    private readonly audit: AuditService,
  ) {}

  /**
   * `GET /api/v1/assignment-settings`.
   *
   * A tenant with no `tenant_settings` row is answered with the built-in
   * fallback and `updatedAt: null`, **not** a 404: that tenant has a working
   * effective default — `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets` is what
   * the resolver coalesces to — and a 404 would say otherwise. In practice
   * provisioning writes the row for every tenant it creates, so this branch is
   * for tenants that predate it.
   */
  async read(): Promise<AssignmentSettingsResponse> {
    const row = await this.prisma.tenantSettings.findUnique({
      where: { tenantId: this.tenantContext.requireTenantId() },
      select: { defaultMaxConcurrentTickets: true, updatedAt: true },
    });

    if (row === null) {
      return {
        defaultMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
        updatedAt: null,
      };
    }

    return {
      defaultMaxConcurrentTickets: row.defaultMaxConcurrentTickets,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * `PATCH /api/v1/assignment-settings`.
   *
   * An **upsert**, so the missing-row case above is not a second failure path
   * here: the first supervisor to set a cap on a legacy tenant creates the row
   * rather than being told there is nothing to patch.
   *
   * Last write wins — no `If-Match`, no version column. Two supervisors editing
   * one integer seconds apart is not a scenario worth a concurrency protocol,
   * and the audit trail records both.
   *
   * Lowering the default below what an agent already holds is allowed and takes
   * no ticket off anybody: rotation skips them until they close down to the new
   * number. It reads like a bug from the queue, so it is stated here and in
   * 0008's failure-mode table rather than discovered.
   */
  async update(input: AssignmentSettingsUpdateInput): Promise<AssignmentSettingsResponse> {
    const tenantId = this.tenantContext.requireTenantId();

    const row = await this.prisma.$tenantTransaction(async (tx) => {
      const before = await tx.tenantSettings.findUnique({
        where: { tenantId },
        select: { defaultMaxConcurrentTickets: true },
      });

      const after = await tx.tenantSettings.upsert({
        where: { tenantId },
        // `tenantId` is explicit: the tenant-scope extension sets the GUC that
        // RLS reads but does not inject the column into `data`, and the
        // `WITH CHECK` half of the policy refuses an insert without it.
        create: { tenantId, defaultMaxConcurrentTickets: input.defaultMaxConcurrentTickets },
        update: { defaultMaxConcurrentTickets: input.defaultMaxConcurrentTickets },
        select: { defaultMaxConcurrentTickets: true, updatedAt: true },
      });

      // Written even when the number is unchanged — unlike the per-user path,
      // where `from === to` means somebody re-sent a form. Here the row may not
      // have existed at all, and "this tenant's default was chosen deliberately"
      // is the question this trail exists to answer; a no-op suppression would
      // lose the first deliberate choice that happened to match the column
      // default of 5.
      await this.audit.record(tx, {
        action: AUDIT_ACTIONS.assignmentSettingsUpdated,
        targetType: 'tenant_settings',
        targetId: tenantId,
        metadata: {
          // `null` when there was no row: the tenant was running on
          // `ASSIGNMENT_POLICY.defaultMaxConcurrentTickets`, which is not the
          // same fact as somebody having set that number.
          from: before?.defaultMaxConcurrentTickets ?? null,
          to: input.defaultMaxConcurrentTickets,
        },
      });

      return after;
    });

    this.logger.log(
      `Tenant default max concurrent tickets set to ${input.defaultMaxConcurrentTickets}`,
    );

    return {
      defaultMaxConcurrentTickets: row.defaultMaxConcurrentTickets,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * `GET /api/v1/assignment-settings/me` — the caller's own capacity.
   *
   * Takes no id and accepts no query, which is what makes "own value only"
   * structural rather than a branch in a serializer a later refactor can drop.
   * `PATCH /users/me/availability` has the same shape for the same reason.
   *
   * There is no matching write. An agent may see the cap that is being applied
   * to them and may not change it — the parent story's assumption, and the whole
   * point of the permission split.
   */
  async readOwn(): Promise<OwnAssignmentCapacityResponse> {
    const tenantId = this.tenantContext.requireTenantId();
    const { userId } = this.tenantContext.requirePrincipal();

    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { maxConcurrentTickets: true },
    });

    const tenantDefault = await readTenantCapacityDefault(this.prisma, tenantId);
    const counts = await readActiveTicketCounts(this.prisma, tenantId, [userId]);

    return {
      // The principal's own row, resolved by `PrincipalGuard` moments ago and
      // visible under RLS by construction. `null` would mean the account was
      // removed mid-request; the caller inherits the tenant default, which is
      // what rotation would use for them.
      ...toAgentCapacity(row?.maxConcurrentTickets ?? null, tenantDefault, counts.get(userId) ?? 0),
      defaultMaxConcurrentTickets: tenantDefault,
    };
  }
}
