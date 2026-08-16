import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AdminPendingDomain } from '@whatsappcrm/contracts';
import { AUDIT_ACTIONS } from '../../audit/audit.actions';
import { AuditService } from '../../audit/audit.service';
import type { Prisma } from '../../generated/prisma/client';
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
 *
 * ## Deactivation is a tenant-visible change, not just a flag
 *
 * A detached domain that is still the tenant's primary is where invite and
 * password-reset links are mailed, so deactivating one has to hand primary back
 * to the platform subdomain in the same transaction (TAR-534). `revertPrimary`
 * is that half, and it is the mirror of the refusal `TenantDomainsService.setPrimary()`
 * makes on the way in.
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
   * Idempotent: attaching a domain twice is a no-op that answers `204` like the
   * first call did, rather than a conflict the operator has to interpret
   * mid-incident.
   */
  async activate(hostname: string): Promise<void> {
    await this.setActivation(hostname, new Date());
  }

  /**
   * The inverse, for a domain detached at the edge. Also idempotent.
   *
   * Deactivating the tenant's **primary** domain moves primary back to the
   * platform subdomain in the same transaction, exactly as
   * `TenantDomainsService.remove()` does — see `revertPrimary` for why that is
   * not optional.
   */
  async deactivate(hostname: string): Promise<void> {
    await this.setActivation(hostname, null);
  }

  private async setActivation(hostname: string, activatedAt: Date | null): Promise<void> {
    await this.tenantPrisma.$tenantTransaction(async (tx) => {
      const row = await tx.tenantDomain.findFirst({
        where: { hostname, kind: 'custom', verifiedAt: { not: null } },
        select: { id: true, hostname: true, activatedAt: true, isPrimary: true },
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

      const revertsPrimary = activatedAt === null && row.isPrimary;

      // `is_primary` is cleared by the same statement that clears
      // `activated_at`, because `tenant_domains_one_primary` is a unique index:
      // the old primary has to be gone before the fallback is set, or the
      // promotion below collides with this write.
      await tx.tenantDomain.update({
        where: { id: row.id },
        data: revertsPrimary ? { activatedAt, isPrimary: false } : { activatedAt },
      });

      const revertedTo = revertsPrimary ? await this.revertPrimary(tx, row.hostname) : null;

      await this.audit.record(tx, {
        action:
          activatedAt === null
            ? AUDIT_ACTIONS.tenantDomainDeactivated
            : AUDIT_ACTIONS.tenantDomainActivated,
        targetType: 'tenant_domain',
        targetId: row.id,
        // The revert is on the deactivation row rather than a row of its own:
        // it is not a separate decision an operator made, it is what this one
        // did, and an auditor asking why a tenant's links changed host needs
        // the two facts together.
        metadata:
          revertedTo === null
            ? { hostname: row.hostname }
            : { hostname: row.hostname, primaryRevertedTo: revertedTo },
      });

      this.logger.log(
        `${row.hostname} marked ${activatedAt === null ? 'detached from' : 'attached at'} the edge`,
      );
    });
  }

  /**
   * Moves primary back to the platform subdomain, and answers which hostname it
   * landed on.
   *
   * A detached domain has no route and no certificate, and `is_primary` is what
   * `TenantLinkService.primaryHostname()` reads to decide where an invite or a
   * password-reset link is **mailed**. Leaving the flag on a domain the edge no
   * longer serves aims every live token at a hostname nobody can reach, and
   * nothing fails visibly — the mail sends, and the tenant discovers it when a
   * customer cannot get back into their account. `TenantDomainsService.setPrimary()`
   * already refuses to *promote* an unactivated domain; this is the same
   * invariant on the way out.
   *
   * The platform subdomain is the destination for the same reason `remove()`
   * chooses it: it is issued under our own zone and served by the same edge as
   * every other tenant's, so it is deliverable without anyone doing anything.
   */
  private async revertPrimary(
    tx: Prisma.TransactionClient,
    detached: string,
  ): Promise<string | null> {
    const fallback = await tx.tenantDomain.findFirst({
      where: { kind: 'platform' },
      select: { id: true, hostname: true },
      orderBy: { createdAt: 'asc' },
    });

    if (fallback === null) {
      // Left without a primary rather than refused: the operator detached a
      // hostname that is genuinely gone from the edge, and `primaryHostname()`
      // already tolerates the absence. Worth a line, because a tenant with no
      // platform subdomain is a provisioning fault this did not cause.
      this.logger.warn(
        `${detached} was primary and is now detached, but its tenant has no platform ` +
          'subdomain to fall back to',
      );

      return null;
    }

    await tx.tenantDomain.update({ where: { id: fallback.id }, data: { isPrimary: true } });

    this.logger.log(`Primary moved from ${detached} to ${fallback.hostname}`);

    return fallback.hostname;
  }
}
