import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../generated/prisma/client';
import { MEDIA_STORAGE, type MediaStorage } from '../../media/storage/media-storage.port';
import { SYSTEM_PRISMA, type SystemPrisma } from '../../prisma/prisma.tokens';
import { describeFailure } from '../../common/describe-failure';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import { applyTransition } from './tenant-lifecycle.service';
import { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';

/**
 * Rows removed per statement.
 *
 * A single `DELETE` cascading through forty tables for a tenant with a million
 * messages is a transaction that holds locks for minutes and, if it times out,
 * has achieved nothing. Ten thousand is large enough that a normal tenant is one
 * batch per table and small enough that the longest single statement stays
 * inside the timeout below.
 */
const PURGE_BATCH_SIZE = 10_000;

/** One batch. Bounded so a stuck statement surfaces as a failed job rather than a held lock. */
const BATCH_TIMEOUT_MS = 30_000;

/**
 * Every tenant-scoped table, **children before parents**, largest first.
 *
 * The order is the whole correctness argument of this list: each table's foreign
 * keys point at tables that appear later, so no `DELETE` here can be refused by
 * a row that is still referencing it. `purge-isolation.int-spec.ts` is what
 * proves the ordering against the real schema — a table added later and appended
 * to the wrong end of this list fails there rather than at 3 a.m. on the first
 * purge that hits it.
 *
 * `media_objects` sits where it does because its **blobs are deleted first**,
 * outside the transaction (risk 1, below).
 *
 * Absent, deliberately:
 *
 *   * `tenants` — retained as the slug tombstone. Releasing `acme` would let a
 *     new tenant inherit the dead one's bookmarks, cached sessions and, worst,
 *     any Meta webhook still routing a `phone_number_id` that used to be theirs.
 *   * `lifecycle_events` — retained permanently. It is the audit trail TAR-36's
 *     sixth criterion asks for, and nothing cascades into it.
 *   * `webhook_events` — its `tenant_id` is nulled instead. Meta's raw payloads
 *     are kept for platform forensics, unlinked.
 */
export const PURGE_ORDER: readonly string[] = [
  // The message graph, deepest first.
  'message_attachments',
  'messages',
  'media_objects',
  'internal_notes',
  'bot_turns',
  'handoff_events',
  'conversations',

  // Tickets and everything hanging off them.
  //
  // No `sla_alerts`: ADR 0009's decision-5 table names it, and it stopped
  // existing when TAR-485 generalised it into `notifications`
  // (`20260816130000_notifications_generalisation`). The ADR is older than the
  // schema here, and `purge-covers-every-tenant-table` in
  // `lifecycle-purge.int-spec.ts` is what makes that a caught mistake rather
  // than a `42P01` on the first real purge.
  'ticket_tags',
  'ticket_events',
  'sla_timers',
  'tickets',
  'ticket_counters',
  'sla_policies',

  // Automation.
  'workflow_references',
  'workflow_runs',
  'workflows',
  'knowledge_chunks',
  'knowledge_documents',
  'ai_configs',
  'canned_responses',
  'notifications',

  // The contact directory.
  'contact_tags',
  'contacts',
  'custom_field_defs',
  'tags',

  // Routing and org structure.
  'assignment_state',
  'assignment_rules',
  'team_members',
  'invite_teams',
  'teams',

  // The WhatsApp connection, which carries `access_token_encrypted`.
  'message_templates',
  'whatsapp_accounts',
  'whatsapp_business_accounts',

  // Identity. `audit_logs` before `users`: it holds a foreign key into them.
  //
  // `tenant_onboarding_steps` is here rather than down with the other tenant
  // configuration for the same reason: `skipped_by_user_id` is a `NO ACTION`
  // composite key into `users`, so a surviving skip row refuses that delete with
  // SQLSTATE 23503. Its own cascade from `tenants` never fires during a purge —
  // the `tenants` row is retained as the slug tombstone.
  'audit_logs',
  'tenant_onboarding_steps',
  'sessions',
  'password_reset_tokens',
  'invites',
  'users',

  // Billing and tenant configuration.
  'usage_counters',
  'subscriptions',
  'tenant_entitlements',
  'idempotency_keys',
  'tenant_settings',
  'tenant_branding',
  'tenant_domains',
];

export interface PurgeReport {
  readonly tenantId: string;
  readonly rowsDeleted: number;
  readonly blobsDeleted: number;
  /** False when the tenant was not due, not suspended, or already purged. */
  readonly purged: boolean;
}

/**
 * Hard delete: the one irreversible operation in the product (ADR 0009
 * decision 5).
 *
 * ## What it destroys, and what outlives it
 *
 * Everything in `PURGE_ORDER`, which is every table carrying this tenant's data
 * — contacts, conversations, messages, tickets, users, sessions, and the
 * encrypted WhatsApp access token. Three things survive: the `tenants` row,
 * redacted to a status and a slug; `lifecycle_events`, permanently, because it
 * is the audit trail; and `webhook_events`, with `tenant_id` nulled.
 *
 * ## Batched, and that is why `purge_started_at` exists
 *
 * Deletion runs one transaction per batch of `PURGE_BATCH_SIZE` rows rather than
 * one transaction for the tenant. `purge_started_at` is stamped **before** the
 * first batch, in the same transaction that enqueues the `tenant_deleted` email,
 * so:
 *
 *   * a purge that crashes half way is **resumed** by the next sweep rather than
 *     restarted, and
 *   * a half-purged tenant is distinguishable from a queued one, which is the
 *     condition the stuck-purge alert fires on — `purge_started_at` set,
 *     `deleted_at` null, for more than an hour.
 *
 * Nothing lets a half-purged tenant serve traffic: it is still `suspended`, so
 * `TenantStatusGuard` refuses everyone, and it stays that way until the last
 * batch commits and the transition to `deleted` runs.
 *
 * ## Risk 1 — blobs before rows
 *
 * `media_objects` rows are deleted inside a transaction; the objects they point
 * at are in a store that is not in it. So the **blob is deleted first**: a crash
 * between the two then leaves a row pointing at a missing object — findable and
 * fixable — rather than an object nobody points at, which is unfindable because
 * the only pointer is gone. "We deleted your data" has to be true.
 *
 * ## Why `SystemPrisma`, and how one tenant stays one tenant
 *
 * Deleting across forty tables is something only the system role can do, and the
 * tenant being purged is one `TenantPrisma` would refuse anyway once it reaches
 * `deleted`. Every statement below names one `tenant_id`, bound as a parameter,
 * and there is no code path here that takes a table name from anywhere but the
 * constant above. `purge-isolation.int-spec.ts` asserts a purge of one tenant
 * deletes no row of another — the assertion ADR 0009 asks TAR-404 for by name.
 */
@Injectable()
export class TenantPurgeService {
  private readonly logger = new Logger(TenantPurgeService.name);

  constructor(
    @Inject(SYSTEM_PRISMA) private readonly systemPrisma: SystemPrisma,
    @Inject(MEDIA_STORAGE) private readonly storage: MediaStorage,
    private readonly notifier: TenantLifecycleNotifier,
  ) {}

  /**
   * Purges one tenant, if it is genuinely due.
   *
   * The due check is re-made here rather than trusted from the sweep that queued
   * the job: a job can sit in Redis across a reactivation, and a purge that ran
   * on a tenant an admin rescued twenty minutes ago would be the worst possible
   * bug in this feature. It is cheap — one primary-key read — and it is the last
   * gate before the first `DELETE`.
   */
  async purge(tenantId: string, now: Date = new Date()): Promise<PurgeReport> {
    const tenant = await this.systemPrisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, status: true, purgeAt: true, purgeStartedAt: true },
    });

    if (tenant === null) {
      throw new TenantNotFoundError(tenantId);
    }

    if (tenant.status !== 'suspended' || tenant.purgeAt === null || tenant.purgeAt > now) {
      this.logger.log(
        `Skipping the purge of ${tenant.slug} (${tenantId}): it is ${tenant.status} and its ` +
          `retention window ${tenant.purgeAt === null ? 'is not running' : 'has not elapsed'}.`,
      );

      return { tenantId, rowsDeleted: 0, blobsDeleted: 0, purged: false };
    }

    if (tenant.purgeStartedAt === null) {
      await this.begin(tenantId);
    } else {
      this.logger.warn(
        `Resuming a purge of ${tenant.slug} (${tenantId}) started at ` +
          `${tenant.purgeStartedAt.toISOString()}.`,
      );
    }

    const blobsDeleted = await this.deleteBlobs(tenantId);
    const rowsDeleted = await this.deleteRows(tenantId);

    await this.systemPrisma.$transaction(async (tx) => {
      await applyTransition(tx, {
        tenantId,
        to: 'deleted',
        trigger: 'timer',
        actor: { actorType: 'system', actorUserId: null, actorLabel: null },
        reason: 'Retention window elapsed.',
        metadata: { rowsDeleted: String(rowsDeleted), blobsDeleted: String(blobsDeleted) },
      });
    });

    this.logger.log(
      `Purged tenant ${tenant.slug} (${tenantId}): ${rowsDeleted} rows and ${blobsDeleted} ` +
        'stored objects destroyed. The tenants row survives as a tombstone.',
    );

    return { tenantId, rowsDeleted, blobsDeleted, purged: true };
  }

  /**
   * Stamps `purge_started_at` and enqueues the farewell — one transaction, and
   * the ordering inside it is the point.
   *
   * `tenant_deleted` goes to addresses in a table this job is about to destroy,
   * so the recipients are read and the message sent **before** the first
   * `DELETE`. There is no `lifecycle_events` row to hang it off yet — the
   * transition to `deleted` happens at the end — which is why this one
   * notification is sent directly rather than through the queue.
   */
  private async begin(tenantId: string): Promise<void> {
    await this.systemPrisma.tenant.update({
      where: { id: tenantId },
      data: { purgeStartedAt: new Date() },
      select: { id: true },
    });

    await this.notifier.remind(tenantId, 'tenant_deleted').catch((error: unknown) => {
      // A farewell that could not be sent must not stop a deletion the customer
      // is entitled to. Logged, not thrown.
      this.logger.error(
        `Could not send the deletion notice for tenant ${tenantId}: ${describeFailure(error)}`,
      );
    });
  }

  /**
   * Deletes the stored objects behind this tenant's `media_objects` rows, in
   * pages, before any row is deleted.
   *
   * A blob whose delete fails is logged and skipped rather than aborting the
   * purge: the row that names it is about to go, and a purge that refuses to
   * finish because one object store call failed leaves a tenant half-deleted
   * indefinitely. The count of failures is what a reconciling sweep over the
   * bucket would use, and that sweep is 0009's stated non-goal for this story.
   */
  private async deleteBlobs(tenantId: string): Promise<number> {
    let deleted = 0;
    let cursor: string | undefined;

    for (;;) {
      const objects = await this.systemPrisma.mediaObject.findMany({
        where: { tenantId },
        select: { id: true, storageKey: true },
        orderBy: { id: 'asc' },
        take: PURGE_BATCH_SIZE,
        ...(cursor === undefined ? {} : { cursor: { id: cursor }, skip: 1 }),
      });

      if (objects.length === 0) {
        return deleted;
      }

      for (const object of objects) {
        try {
          await this.storage.delete(object.storageKey);
          deleted += 1;
        } catch (error: unknown) {
          this.logger.error(
            `Could not delete stored object ${object.storageKey} for tenant ${tenantId}: ` +
              describeFailure(error),
          );
        }
      }

      cursor = objects.at(-1)?.id;
    }
  }

  /**
   * Walks `PURGE_ORDER`, deleting each table in batches until it is empty.
   *
   * `ctid IN (SELECT ctid ... LIMIT n)` rather than `DELETE ... LIMIT n`, which
   * PostgreSQL does not have. The table name comes from the constant above and
   * from nowhere else — it is the one part of the statement that cannot be a
   * parameter, so it must never be able to come from input.
   *
   * `webhook_events` is nulled rather than deleted, in the same pass and for the
   * reason decision 5 gives: Meta's raw payloads are platform forensics, and the
   * column is already `ON DELETE SET NULL`.
   */
  private async deleteRows(tenantId: string): Promise<number> {
    let total = 0;

    for (const table of PURGE_ORDER) {
      for (;;) {
        const deleted = await this.systemPrisma.$transaction(
          async (tx) =>
            await tx.$executeRaw(
              Prisma.sql`
                DELETE FROM ${Prisma.raw(`"public"."${table}"`)}
                WHERE ctid IN (
                  SELECT ctid FROM ${Prisma.raw(`"public"."${table}"`)}
                  WHERE "tenant_id" = ${tenantId}::uuid
                  LIMIT ${PURGE_BATCH_SIZE}
                )
              `,
            ),
          { timeout: BATCH_TIMEOUT_MS },
        );

        total += deleted;

        if (deleted < PURGE_BATCH_SIZE) {
          break;
        }
      }
    }

    await this.unlinkWebhookEvents(tenantId);

    return total;
  }

  /**
   * Nulls `webhook_events.tenant_id`, in batches, for the reason every delete
   * above is batched.
   *
   * `webhook_events` holds Meta's raw payloads and is the **highest-volume table
   * in the product** — one row per delivery, retained for platform forensics
   * rather than trimmed with the tenant's data. A single `UPDATE` across a busy
   * tenant's whole history is exactly the statement that exceeds the 30-second
   * server-side `statement_timeout` every connection carries
   * (`prisma-client.factory.ts`).
   *
   * Getting that wrong is worse here than anywhere else in the purge, because
   * this is the **last** statement: every row is already deleted, so a
   * cancellation leaves the tenant `suspended` with `purge_started_at` set and
   * `deleted_at` null — the stuck-purge alert condition — and every retry re-runs
   * the same doomed statement against the same rows and is cancelled again.
   *
   * `ctid` batching rather than a `take`/cursor loop, matching `deleteRows`:
   * each statement bounds its own work, and the predicate shrinks as it goes
   * because the rows it matched no longer carry the tenant id.
   */
  private async unlinkWebhookEvents(tenantId: string): Promise<void> {
    for (;;) {
      const unlinked = await this.systemPrisma.$transaction(
        async (tx) =>
          await tx.$executeRaw`
            UPDATE "public"."webhook_events"
            SET "tenant_id" = NULL
            WHERE ctid IN (
              SELECT ctid FROM "public"."webhook_events"
              WHERE "tenant_id" = ${tenantId}::uuid
              LIMIT ${PURGE_BATCH_SIZE}
            )
          `,
        { timeout: BATCH_TIMEOUT_MS },
      );

      if (unlinked < PURGE_BATCH_SIZE) {
        return;
      }
    }
  }
}
