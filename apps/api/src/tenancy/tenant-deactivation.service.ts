import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolveAuditActor, type AuditActor } from '../audit/audit-actor';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
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

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    private readonly tenantContext: TenantContextService,
  ) {}

  async deactivate(command: DeactivateTenantCommand): Promise<DeactivateTenantResult> {
    const result = await this.systemPrisma.$transaction(
      async (tx) => {
        // Serialises concurrent deactivation of the same slug. Held to the end
        // of the transaction and released by commit or rollback, so a crashed
        // caller cannot leave it held.
        //
        // `hashtext` is an internal function whose result is not contractually
        // stable across major versions. That is acceptable here and matches
        // TAR-50: a changed hash only means two callers stop sharing a lock they
        // contend for rarely, and the unique index on `tenants.slug` — not this
        // lock — is what guarantees correctness.
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
          : {
              tenant: await suspendTenant(
                tx,
                existing.id,
                command.reason,
                // Read here rather than inside `suspendTenant`, so the actor is
                // resolved from the request scope in one place and cannot be
                // assembled by hand into a combination
                // `audit_logs_actor_attribution` rejects.
                resolveAuditActor(this.tenantContext),
              ),
              deactivated: true,
            };
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
 * user inside this tenant — the column is a foreign key into this tenant's
 * `users`, and the platform will never be a row there. Since TAR-166 that no
 * longer means the row is anonymous: `actor_type` says `platform_operator` and
 * `actor_label` names the credential that authenticated the request, so "who
 * shut this tenant off" has an answer without a foreign key that cannot exist.
 *
 * Written directly rather than through `AuditService` because this row is not
 * the audit of a tenant-scoped change: it runs under `SystemPrisma` against a
 * tenant nobody is in the scope of, and it carries the transaction's `now()`.
 * The actor still comes from the request scope — the rule that matters — via
 * `resolveAuditActor`, which is the same value `AuditService` would have used.
 *
 * Both timestamps come from the **database** clock, read once as `now()` —
 * transaction start — and written to both rows. Two API instances a few seconds
 * apart would otherwise be able to order the audit trail inconsistently with
 * the row it describes.
 *
 * `created_at` is passed explicitly rather than left to its column default, and
 * that is not belt and braces: `audit_logs.created_at` does carry
 * `DEFAULT CURRENT_TIMESTAMP`, but Prisma 7's client generates `@default(now())`
 * values itself and sends them, so the default never fires and the value would
 * be the process clock at insert time. Measured here at 57 ms after transaction
 * start on an idle local database. Naming the value is what actually makes the
 * two agree.
 */
async function suspendTenant(
  tx: Prisma.TransactionClient,
  tenantId: string,
  reason: string | undefined,
  actor: AuditActor,
): Promise<DeactivatedTenant> {
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;

  const tenant = await tx.tenant.update({
    where: { id: tenantId },
    data: { status: 'suspended', suspendedAt: now },
    select: TENANT_PROJECTION,
  });

  await tx.auditLog.create({
    data: {
      tenantId: tenant.id,
      // Never a user in this tenant: this is the platform acting on it, and
      // `actor_label` is what names which operator credential did.
      ...actor,
      action: TENANT_DEACTIVATED_ACTION,
      targetType: 'tenant',
      targetId: tenant.id,
      // The same instant the row above was stamped with. See the note above on
      // why the column default is not what would happen otherwise.
      createdAt: now,
      // Operator-supplied free text, and the only thing here that did not come
      // from the database. Recorded as given; never rendered to the tenant, and
      // never a place for a credential.
      metadata: reason === undefined ? undefined : { reason },
    },
    select: { id: true },
  });

  return tenant;
}
