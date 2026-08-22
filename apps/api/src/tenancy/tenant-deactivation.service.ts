import { Inject, Injectable, Logger } from '@nestjs/common';
import { resolveAuditActor, type AuditActor } from '../audit/audit-actor';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { $Enums, Prisma } from '../generated/prisma/client';
import { SYSTEM_PRISMA, type SystemPrisma } from '../prisma/prisma.tokens';
import { NOTIFY_TENANT_LIFECYCLE_JOB, TENANCY_QUEUE } from '../queue/queue.constants';
import { QueueService } from '../queue/queue.service';
import {
  LIFECYCLE_NOTIFICATION_JOB_OPTIONS,
  lifecycleNotificationJobId,
} from './lifecycle/lifecycle-jobs';
import { applyTransition } from './lifecycle/tenant-lifecycle.service';
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
 * The statuses from which there is nothing left to deactivate. `TenantStatusGuard`
 * already refuses every principal on all three, so the tenant's agents are
 * locked out and re-stamping `suspended_at` would only overwrite the record of
 * when that happened.
 *
 * `deleted` joins them with TAR-403, and not merely for tidiness: it is a
 * terminal state — `TENANT_STATUS_TRANSITIONS` gives it no outgoing edge — so
 * without this entry a deactivate call would move a purged tenant to
 * `suspended`, undoing the one status the audit trail says can never be left.
 */
const ALREADY_INACCESSIBLE: readonly $Enums.TenantStatus[] = ['suspended', 'cancelled', 'deleted'];

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
 * Admin-triggered tenant deactivation (TAR-19, third acceptance criterion),
 * delegating to the lifecycle engine since TAR-404.
 *
 * ## What it does, and what it deliberately does not
 *
 * Deactivation moves the tenant to `suspended` and records who did it. That is
 * the whole operation, and the reason it is safe:
 *
 *   * **The data is retained.** Nothing is deleted, anonymised or moved. Every
 *     contact, conversation, ticket and message the tenant ever wrote stays
 *     exactly where it was, reachable through `SystemPrisma` for support,
 *     billing, export and reactivation. Deletion is a separate operation with a
 *     retention window, and it is not this one.
 *   * **Access is revoked at request pipeline stage 4.** `TenantStatusGuard`
 *     reads the status this writes and refuses every principal on every route
 *     except the recovery allowlist an admin needs to pay their way back in.
 *     Before TAR-404 the block lived in the data layer, in
 *     `assert_tenant_active` — it moved because a suspended tenant's **inbound
 *     WhatsApp messages must still be stored** (ADR 0009 decision 2), which a
 *     database gate that refused `suspended` made impossible. `TenantPrisma`
 *     therefore now admits a suspended tenant, and the HTTP guard is what keeps
 *     its people out.
 *   * **No other tenant is touched.** One row is written, identified by slug.
 *     A neighbour's queries do not change shape, cost or result.
 *
 * Two things it leaves to their owners. It does not revoke sessions — TAR-35
 * owns `sessions` and login, and refuses an agent or supervisor of a suspended
 * tenant there; an admin's surviving session reaches only the allowlist. And it
 * does not reactivate: `POST /admin/tenants/{slug}/reactivate` is the inverse,
 * and putting it here would make an endpoint that exists to take access away
 * also the one that gives it back.
 *
 * ## What is written, and by whom
 *
 * `tenants.status`, the timer columns and the `lifecycle_events` row are
 * `TenantLifecycleService`'s — this delegates through `applyTransition`, so an
 * operator deactivation lands in the lifecycle trail alongside every other route
 * to `suspended` and starts the same retention clock. What stays here is the
 * `audit_logs` row, the slug identity of the request, and the advisory lock.
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
    private readonly queue: QueueService,
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

        if (ALREADY_INACCESSIBLE.includes(existing.status)) {
          return { tenant: existing, deactivated: false, eventId: null };
        }

        // The status write, the timer columns and the `lifecycle_events` row all
        // belong to the single writer (ADR 0009, the transition seam). What
        // stays here is the operator-facing audit row, the slug identity of the
        // request, and the lock.
        //
        // `applyTransition` rather than `TenantLifecycleService.transition`,
        // because that method opens its own transaction — nesting one inside
        // this one would either deadlock on the advisory lock it takes or commit
        // the status write independently of the `audit_logs` row below, which is
        // exactly the gap this transaction exists to close.
        const { state, eventId } = await applyTransition(tx, {
          tenantId: existing.id,
          to: 'suspended',
          trigger: 'operator_action',
          // Resolved from the request scope in one place, so no call site can
          // assemble a combination `lifecycle_events_actor_attribution` rejects.
          actor: resolveAuditActor(this.tenantContext),
          reason: command.reason,
        });

        await recordDeactivationAudit(
          tx,
          state,
          command.reason,
          resolveAuditActor(this.tenantContext),
        );

        return { tenant: state, deactivated: true, eventId };
      },
      { timeout: TRANSACTION_TIMEOUT_MS },
    );

    await this.notifyDeactivation(result);

    this.logger.log(
      result.deactivated
        ? `Deactivated tenant ${result.tenant.slug} (${result.tenant.id}): its data is retained and its agents can no longer reach it`
        : `Tenant ${result.tenant.slug} (${result.tenant.id}) is already ${result.tenant.status}; no changes made`,
    );

    return { tenant: result.tenant, deactivated: result.deactivated };
  }

  /**
   * The `tenant_suspended` email, enqueued **after** the commit.
   *
   * The same rule the rest of the lifecycle follows and for the same reason: a
   * mailer or Redis outage that rolled this transaction back would leave a
   * tenant an operator meant to shut off still running. The `lifecycle_events`
   * row is already committed with `notified_at IS NULL`, so the sweep is the
   * backstop if this fails — which is why `enqueue` reporting anything other
   * than `added` is a log line rather than an error.
   */
  private async notifyDeactivation({ eventId, tenant }: DeactivationOutcome): Promise<void> {
    if (eventId === null) {
      return;
    }

    const outcome = await this.queue.enqueue(
      TENANCY_QUEUE,
      NOTIFY_TENANT_LIFECYCLE_JOB,
      { tenantId: tenant.id, eventId },
      // Deterministic on the audit row, so a redelivery of the same transition
      // is a duplicate BullMQ discards rather than a second email to every admin.
      // Retries and retention come from the shared options — without `attempts`
      // one transient mailer failure would be terminal for this notice.
      { jobId: lifecycleNotificationJobId(eventId), ...LIFECYCLE_NOTIFICATION_JOB_OPTIONS },
    );

    if (outcome !== 'added') {
      this.logger.warn(
        `Could not queue the suspension notice for lifecycle event ${eventId} (${outcome}); ` +
          'the lifecycle sweep will re-enqueue it.',
      );
    }
  }
}

/** What the transaction returns, before the published result drops the event id. */
interface DeactivationOutcome {
  tenant: DeactivatedTenant;
  deactivated: boolean;
  eventId: string | null;
}

/**
 * The **operator-facing** audit entry, which has to land or roll back with the
 * status write. An access revocation nobody can account for afterwards is the
 * kind of gap a SOC 2 style audit asks about, so the two are one transaction
 * rather than two statements that usually both succeed.
 *
 * ## Why this survives alongside `lifecycle_events`
 *
 * The transition now writes a `lifecycle_events` row too, and the two are not
 * redundant. `lifecycle_events` is the state machine's trail: platform-level,
 * append-only, and it outlives the purge. `audit_logs` is the **tenant's own**
 * operational audit, tenant-scoped and readable by whatever support tooling
 * reads the rest of that table — and `tenant.deactivated` has been its action
 * name since TAR-51, with readers that would lose the answer to "when did this
 * tenant lose access" if it stopped being written.
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
 * tenant nobody is in the scope of.
 *
 * The timestamp comes from the **database** clock, read as `now()` —
 * transaction start, therefore the same instant `applyTransition` stamped the
 * tenant row and the lifecycle event with. Two API instances a few seconds apart
 * would otherwise be able to order the audit trail inconsistently with the row
 * it describes.
 *
 * `created_at` is passed explicitly rather than left to its column default, and
 * that is not belt and braces: `audit_logs.created_at` does carry
 * `DEFAULT CURRENT_TIMESTAMP`, but Prisma 7's client generates `@default(now())`
 * values itself and sends them, so the default never fires and the value would
 * be the process clock at insert time. Measured here at 57 ms after transaction
 * start on an idle local database. Naming the value is what actually makes the
 * two agree.
 */
async function recordDeactivationAudit(
  tx: Prisma.TransactionClient,
  tenant: DeactivatedTenant,
  reason: string | undefined,
  actor: AuditActor,
): Promise<void> {
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT now() AS now`;

  await tx.auditLog.create({
    data: {
      tenantId: tenant.id,
      // Never a user in this tenant: this is the platform acting on it, and
      // `actor_label` is what names which operator credential did.
      ...actor,
      action: TENANT_DEACTIVATED_ACTION,
      targetType: 'tenant',
      targetId: tenant.id,
      // The same instant the two rows above were stamped with. See the note
      // above on why the column default is not what would happen otherwise.
      createdAt: now,
      // Operator-supplied free text, and the only thing here that did not come
      // from the database. Recorded as given; never rendered to the tenant, and
      // never a place for a credential.
      metadata: reason === undefined ? undefined : { reason },
    },
    select: { id: true },
  });
}
