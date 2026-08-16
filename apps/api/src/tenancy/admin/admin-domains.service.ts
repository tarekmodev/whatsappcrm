import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminPendingDomain } from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../../audit/audit.actions';
import { AuditService } from '../../audit/audit.service';
import {
  SYSTEM_PRISMA,
  TENANT_PRISMA,
  type SystemPrisma,
  type TenantPrisma,
} from '../../prisma/prisma.tokens';
import { TenantDomainNotFoundError } from '../tenancy.errors';

/** How many entries the operator queue returns at once. */
const QUEUE_LIMIT = 200;

/**
 * The platform-operator half of custom domains: the activation queue, and the
 * record that a hostname has been attached at the edge (TAR-419,
 * `docs/runbooks/custom-domains.md`).
 *
 * ## Why activation is a record rather than an action
 *
 * Attaching a domain at Render's edge is a Dashboard step. TAR-416 declined to
 * automate it, because nobody here has read Render's domains API and specifying
 * a contract against an unread one is inventing it. What this endpoint does is
 * close the loop: it stamps `activated_at`, which takes the domain off the queue
 * below, moves its published status to `live`, and gives the audit trail a row
 * naming which operator credential did it.
 *
 * When the automation lands it replaces the *body* of `activate` and changes
 * nothing a tenant sees.
 *
 * ## Two clients, and each is doing its own job
 *
 * The queue spans tenants, so it reads through `SystemPrisma` — platform
 * reporting, which is one of the call sites ADR 0002 permits. Activation names
 * one tenant, and the controller has already entered that tenant's scope through
 * `AdminTenantScopeService`, so the write goes through `TenantPrisma` under RLS
 * and the audit row lands in the right tenant.
 */
@Injectable()
export class AdminDomainsService {
  private readonly logger = new Logger(AdminDomainsService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    @Inject(TENANT_PRISMA) private readonly tenantPrisma: TenantPrisma,
    private readonly audit: AuditService,
  ) {}

  /**
   * Domains waiting to be attached, or already attached.
   *
   * `verified` is the working queue — proved by the tenant, not yet serving —
   * and it is the thing to watch: TAR-416 names "verified for more than 24 hours
   * with no activation" as the failure mode this feature actually has, because a
   * manual step with no queue is a step that gets forgotten.
   */
  async pending(status: 'verified' | 'live'): Promise<AdminPendingDomain[]> {
    const rows = await this.systemPrisma.tenantDomain.findMany({
      where: {
        kind: 'custom',
        verifiedAt: { not: null },
        activatedAt: status === 'live' ? { not: null } : null,
      },
      select: {
        hostname: true,
        verifiedAt: true,
        activatedAt: true,
        tenant: { select: { slug: true, name: true } },
      },
      // Oldest first: the queue is a to-do list, and the domain that has waited
      // longest is the one closest to being a support ticket.
      orderBy: { verifiedAt: 'asc' },
      take: QUEUE_LIMIT,
    });

    return rows.flatMap((row) =>
      row.verifiedAt === null
        ? []
        : [
            {
              tenantSlug: row.tenant.slug,
              tenantName: row.tenant.name,
              hostname: row.hostname,
              verifiedAt: row.verifiedAt.toISOString(),
              activatedAt: row.activatedAt?.toISOString() ?? null,
            },
          ],
    );
  }

  /**
   * Records that `hostname` is now attached at the edge with a certificate.
   *
   * Refuses a domain that is not verified. Activation is not a way to make a
   * hostname resolve — `HostTenantGuard` reads `verified_at`, not this column —
   * so allowing it on an unproved claim would only produce a row that says
   * `live` while answering `tenant_not_found`, which is worse than a refusal.
   *
   * Idempotent: attaching a domain twice is a no-op, and the operator finding
   * out it was already done is a `200` rather than a conflict they have to
   * interpret mid-incident.
   */
  async activate(hostname: string): Promise<void> {
    await this.setActivation(hostname, new Date());
  }

  /** The inverse, for a domain detached at the edge. Also idempotent. */
  async deactivate(hostname: string): Promise<void> {
    await this.setActivation(hostname, null);
  }

  private async setActivation(hostname: string, activatedAt: Date | null): Promise<void> {
    await this.tenantPrisma.$tenantTransaction(async (tx) => {
      const row = await tx.tenantDomain.findFirst({
        where: { hostname, kind: 'custom', verifiedAt: { not: null } },
        select: { id: true, hostname: true, activatedAt: true },
      });

      if (row === null) {
        // Absent, in another tenant, or not verified — one answer for all three.
        // The operator is authorised for every tenant, but the slug in the path
        // is the tenant they *named*, and silently acting on another one is how
        // a domain gets attached to the wrong environment's data.
        throw new TenantDomainNotFoundError();
      }

      if ((row.activatedAt === null) === (activatedAt === null)) {
        return;
      }

      await tx.tenantDomain.update({ where: { id: row.id }, data: { activatedAt } });

      await this.audit.record(tx, {
        action:
          activatedAt === null
            ? AUDIT_ACTIONS.tenantDomainDeactivated
            : AUDIT_ACTIONS.tenantDomainActivated,
        targetType: 'tenant_domain',
        targetId: row.id,
        metadata: { hostname: row.hostname },
      });

      this.logger.log(
        `${row.hostname} marked ${activatedAt === null ? 'detached from' : 'attached at'} the edge`,
      );
    });
  }
}
