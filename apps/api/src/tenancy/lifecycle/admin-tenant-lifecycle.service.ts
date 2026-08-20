import { Inject, Injectable, Logger } from '@nestjs/common';
import type { TenantStatus } from '@whatsappcrm/contracts';
import { resolveAuditActor } from '../../audit/audit-actor';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import { TenantLifecycleService, type TenantLifecycleState } from './tenant-lifecycle.service';

/**
 * The operator surface's adapter onto the lifecycle engine (TAR-36, ADR 0009's
 * four `PLATFORM_ADMIN_TOKEN` routes).
 *
 * It exists for one reason: the operator has a **slug** and the state machine
 * has an **id**. Resolving one to the other has to happen somewhere, and doing
 * it in the controller would put a `SystemPrisma` read in a class whose job is
 * shaping HTTP — and would put it there four times.
 *
 * Everything else it does is deliberately thin. It does not decide which
 * transitions are legal, it does not write `tenants`, and it does not write the
 * trail: `TenantLifecycleService` is still the only writer, and this only ever
 * hands it a tenant id, a target state and the actor from the request scope.
 */
@Injectable()
export class AdminTenantLifecycleService {
  private readonly logger = new Logger(AdminTenantLifecycleService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly lifecycle: TenantLifecycleService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * The tenant behind a slug.
   *
   * `TenantNotFoundError` rather than a silent success for an unknown one, for
   * the reason deactivation gives: an operator who mistypes a slug during an
   * incident needs to know the tenant they meant is still running.
   */
  async bySlug(slug: string): Promise<TenantLifecycleState> {
    const tenant = await this.systemPrisma.tenant.findUnique({
      where: { slug },
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        trialEndsAt: true,
        gracePeriodEndsAt: true,
        suspendedAt: true,
        cancelledAt: true,
        purgeAt: true,
        purgeStartedAt: true,
        deletedAt: true,
      },
    });

    if (tenant === null) {
      throw new TenantNotFoundError(slug);
    }

    return tenant;
  }

  async transitionBySlug(
    slug: string,
    to: TenantStatus,
    reason?: string,
  ): Promise<TenantLifecycleState> {
    const tenant = await this.bySlug(slug);

    const { state } = await this.lifecycle.transition({
      tenantId: tenant.id,
      to,
      trigger: 'operator_action',
      // From the request scope, so the row records the credential
      // `PlatformAdminGuard` actually authenticated rather than one a handler
      // assembled. `platform_operator` with a label and no user is the only
      // combination `lifecycle_events_actor_attribution` accepts here — the
      // operator is not a user inside this tenant and never will be.
      actor: resolveAuditActor(this.tenantContext),
      reason,
    });

    return state;
  }

  /**
   * Brings a suspended tenant's `purge_at` forward to now, so the next sweep
   * purges it (`force: true` on `POST /admin/tenants/{slug}/delete`).
   *
   * ⚠️ **This is the only way to shorten the retention window**, and it exists
   * for a right-to-erasure request that cannot wait 44 days. It moves the clock
   * rather than adding a second road to `deleted`: the purge still runs from the
   * sweep, still through `TenantPurgeService`, still writes the same transition
   * and the same audit row. One deletion path, one clock.
   *
   * It refuses anything that is not `suspended`. The caller reaches that state
   * through a normal `operator_action` transition first, which is audited on its
   * own row — so a forced deletion leaves two entries, and the second one names
   * the shortened window in its metadata.
   *
   * The status is re-read here rather than trusted from the caller, so this
   * cannot be aimed at a tenant that was reactivated in between.
   */
  async expedite(tenantId: string): Promise<TenantLifecycleState> {
    const { count } = await this.systemPrisma.tenant.updateMany({
      where: { id: tenantId, status: 'suspended' },
      data: { purgeAt: new Date() },
    });

    if (count === 0) {
      throw new TenantNotFoundError(tenantId);
    }

    this.logger.warn(
      `Retention window for tenant ${tenantId} brought forward to now by ` +
        `${this.tenantContext.platformActorLabel ?? 'an operator'}: the next lifecycle sweep ` +
        'will purge it.',
    );

    return await this.lifecycle.state(tenantId);
  }
}
