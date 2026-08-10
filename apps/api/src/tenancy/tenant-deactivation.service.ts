import { Inject, Injectable, Logger } from '@nestjs/common';
import type { $Enums, Prisma } from '../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { TenantNotFoundError } from './tenant-deactivation.errors';

/**
 * Namespace for the advisory lock, so the hash cannot collide with a lock some
 * other feature takes on the same slug.
 */
const DEACTIVATION_LOCK_PREFIX = 'tenant-deactivation:';

/** Two statements and a lock. Generous enough for a busy database, short enough to give up. */
const TRANSACTION_TIMEOUT_MS = 10_000;

/**
 * The audit action, spelled once. Read by support tooling and by whatever
 * answers "when did this tenant lose access, and who said so".
 */
export const TENANT_DEACTIVATED_ACTION = 'tenant.deactivated';

/**
 * The statuses from which there is nothing left to deactivate. Both already
 * fail `assert_tenant_active`, so the tenant's agents are already locked out
 * and re-stamping `suspended_at` would only overwrite the record of when that
 * happened.
 */
const ALREADY_INACCESSIBLE: readonly $Enums.TenantStatus[] = ['suspended', 'cancelled'];

/** What deactivation writes, and the only columns it reads back. */
export interface DeactivatedTenant {
  id: string;
  slug: string;
  name: string;
  status: $Enums.TenantStatus;
  /** When the tenant was deactivated, or null if it reached this status another way. */
  suspendedAt: Date | null;
}

export interface DeactivateTenantCommand {
  slug: string;
  /** Free text for the audit trail. Never shown to the tenant. */
  reason?: string;
}

export interface DeactivateTenantResult {
  tenant: DeactivatedTenant;
  /** False when the tenant was already inaccessible and this call changed nothing. */
  deactivated: boolean;
}

/** The columns the result is built from — nothing else is read. */
const TENANT_PROJECTION = {
  id: true,
  slug: true,
  name: true,
  status: true,
  suspendedAt: true,
} as const;

/**
 * Admin-triggered tenant deactivation (TAR-19, third acceptance criterion).
 *
 * ## What it does, and what it deliberately does not
 *
 * Deactivation writes two columns — `tenants.status` and `tenants.suspended_at`
 * — and nothing else. That is the whole operation, and the reason it is safe:
 *
 *   * **The data is retained.** Nothing is deleted, anonymised or moved. Every
 *     contact, conversation, ticket and message the tenant ever wrote stays
 *     exactly where it was, reachable through `SystemPrisma` for support,
 *     billing, export and reactivation. Deletion is a separate operation with a
 *     retention window, and it is not this one.
 *   * **Access is revoked at the data layer, not at the edge.** The status this
 *     writes is read by `assert_tenant_active`
 *     (`20260810150000_tenant_deactivation_guard`), which every `TenantPrisma`
 *     statement passes through on its way to setting the RLS GUC. So the block
 *     covers HTTP handlers, queue workers, WebSocket handlers and raw SQL
 *     alike, and it is in force from the instant this transaction commits —
 *     there is no cache to expire and no guard a new route could forget to
 *     apply.
 *   * **No other tenant is touched.** One row is written, identified by slug,
 *     and the gate reads only the row named by the GUC. A neighbour's queries
 *     do not change shape, cost or result.
 *
 * Two things it leaves to their owners. It does not revoke sessions — TAR-35
 * owns `sessions` and login, and must refuse a non-active tenant there so a
 * deactivated tenant cannot get as far as a session; the gate below means such
 * a session would reach no data in any case. And it does not reactivate:
 * `suspended → active` is the lifecycle state machine TAR-36 owns, and putting
 * the inverse here would make an endpoint that exists to take access away also
 * the one that gives it back.
 *
 * ## Why `SystemPrisma`
 *
 * `tenants` carries no RLS policy and `TenantPrisma` refuses to write it — and
 * could not do this work anyway, since the tenant it would need in scope is the
 * one being locked out. Lifecycle is one of the five call sites TAR-39 permits
 * for the unscoped client. Every statement here names the single tenant it was
 * asked about.
 *
 * ## Idempotency
 *
 * The slug is the identity of the request. Everything happens inside one
 * transaction that first takes a transaction-scoped advisory lock on that slug,
 * so two operators deactivating the same tenant at once produce one write, one
 * audit entry and one honest answer about which call did it. A repeat call
 * finds the tenant already inaccessible and returns it unchanged, keeping the
 * original `suspended_at` — the record of when access was actually revoked.
 */
@Injectable()
export class TenantDeactivationService {
  private readonly logger = new Logger(TenantDeactivationService.name);

  constructor(@Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma) {}

  async deactivate(command: DeactivateTenantCommand): Promise<DeactivateTenantResult> {
    const result = await this.systemPrisma.$transaction(
      async (tx) => {
        // Serialises concurrent deactivation of the same slug. Held to the end
        // of the transaction and released by commit or rollback, so a crashed
        // caller cannot leave it held.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${DEACTIVATION_LOCK_PREFIX + command.slug}))`;

        const existing = await tx.tenant.findUnique({
          where: { slug: command.slug },
          select: TENANT_PROJECTION,
        });

        if (existing === null) {
          throw new TenantNotFoundError(command.slug);
        }

        return ALREADY_INACCESSIBLE.includes(existing.status)
          ? { tenant: existing, deactivated: false }
          : { tenant: await suspendTenant(tx, existing.id, command.reason), deactivated: true };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    this.logger.log(
      result.deactivated
        ? `Deactivated tenant ${result.tenant.slug} (${result.tenant.id}): its data is retained and its agents can no longer reach it`
        : `Tenant ${result.tenant.slug} (${result.tenant.id}) is already ${result.tenant.status}; no changes made`,
    );

    return result;
  }
}

/**
 * The write, plus the audit entry that has to land or roll back with it. An
 * access revocation nobody can account for afterwards is the kind of gap a
 * SOC 2 style audit asks about, so the two are one transaction rather than two
 * statements that usually both succeed.
 *
 * `actorUserId` stays null: the actor is the platform operator, who is not a
 * user inside this tenant. When a real platform-admin identity exists (TAR-35,
 * TAR-22) it belongs in `metadata` alongside the reason — the column is a
 * foreign key into this tenant's `users`, and the platform will never be a row
 * there.
 */
async function suspendTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  reason: string | undefined,
): Promise<DeactivatedTenant> {
  const tenant = await tx.tenant.update({
    where: { id: tenantId },
    data: { status: 'suspended', suspendedAt: new Date() },
    select: TENANT_PROJECTION,
  });

  await tx.auditLog.create({
    data: {
      tenantId: tenant.id,
      // Never a user in this tenant: this is the platform acting on it.
      actorUserId: null,
      action: TENANT_DEACTIVATED_ACTION,
      targetType: 'tenant',
      targetId: tenant.id,
      // Operator-supplied free text, and the only thing here that did not come
      // from the database. Recorded as given; never rendered to the tenant, and
      // never a place for a credential.
      metadata: reason === undefined ? undefined : { reason },
    },
    select: { id: true },
  });

  return tenant;
}
