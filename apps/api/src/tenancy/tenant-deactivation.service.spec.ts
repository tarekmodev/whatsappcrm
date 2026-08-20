import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma } from '../generated/prisma/client';
import type { SystemPrisma } from '../prisma/prisma.tokens';
import { NOTIFY_TENANT_LIFECYCLE_JOB, TENANCY_QUEUE } from '../queue/queue.constants';
import type { QueueService } from '../queue/queue.service';
import { lifecycleNotificationJobId } from './lifecycle/lifecycle-jobs';
import { TenantNotFoundError } from './tenant-deactivation.errors';
import {
  TenantDeactivationService,
  TENANT_DEACTIVATED_ACTION,
} from './tenant-deactivation.service';

/**
 * The decisions deactivation makes before it writes anything: which statuses it
 * acts on, what it leaves alone, and what it records. The database is stubbed —
 * that the write actually locks the tenant out is a property of the guard and of
 * the database, and is proved in `tenant-status.guard.spec.ts` and
 * `tenant-deactivation.int-spec.ts`.
 *
 * Since TAR-404 the status write, the timer columns and the `lifecycle_events`
 * row belong to `TenantLifecycleService`, which this delegates to through
 * `applyTransition`. What is asserted here is what deactivation *still* owns:
 * the slug identity of the request, the advisory lock, the `audit_logs` row, and
 * the decision not to act on a tenant that is already inaccessible.
 */

const TENANT_ID = '51444444-4444-7444-8444-4444444444a1';
const SLUG = 'acme';

type TenantRow = {
  id: string;
  slug: string;
  name: string;
  status: 'created' | 'trialing' | 'active' | 'past_due' | 'suspended' | 'cancelled' | 'deleted';
  suspendedAt: Date | null;
};

const ACTIVE: TenantRow = {
  id: TENANT_ID,
  slug: SLUG,
  name: 'Acme Ltd',
  status: 'active',
  suspendedAt: null,
};

/** What the stubbed `SELECT now()` returns — the database's clock, not the process's. */
const DATABASE_NOW = new Date('2026-08-10T10:30:00.000Z');

describe('TenantDeactivationService', () => {
  let findUnique: jest.Mock;
  let update: jest.Mock;
  let createAuditLog: jest.Mock;
  let createLifecycleEvent: jest.Mock;
  let executeRaw: jest.Mock;
  let queryRaw: jest.Mock;
  let enqueue: jest.Mock;
  let tenantContext: TenantContextService;
  let service: TenantDeactivationService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(ACTIVE);
    update = jest.fn().mockImplementation(({ data }: { data: Partial<TenantRow> }) =>
      Promise.resolve({
        ...ACTIVE,
        status: data.status ?? ACTIVE.status,
        suspendedAt: data.suspendedAt ?? null,
      }),
    );
    createAuditLog = jest.fn().mockResolvedValue({ id: 'audit' });
    createLifecycleEvent = jest.fn().mockResolvedValue({ id: 'event' });
    executeRaw = jest.fn().mockResolvedValue(1);
    queryRaw = jest.fn().mockResolvedValue([{ now: DATABASE_NOW }]);
    enqueue = jest.fn().mockResolvedValue('added');

    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: queryRaw,
      tenant: { findUnique, update },
      auditLog: { create: createAuditLog },
      lifecycleEvent: { create: createLifecycleEvent },
    } as unknown as Prisma.TransactionClient;

    const systemPrisma = {
      $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
    } as unknown as SystemPrisma;

    tenantContext = new TenantContextService();
    service = new TenantDeactivationService(systemPrisma, tenantContext, {
      enqueue,
    } as unknown as QueueService);
  });

  /** Runs `work` as if `PlatformAdminGuard` had authenticated `label`. */
  function asOperator<T>(label: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'req_deactivation', tenantId: null, userId: null, principal: null },
      async () => {
        tenantContext.setPlatformActor(label);

        return await work();
      },
    );
  }

  describe('deactivating a running tenant', () => {
    it('suspends it and stamps when access was revoked', async () => {
      const { tenant, deactivated } = await service.deactivate({ slug: SLUG });

      expect(deactivated).toBe(true);
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TENANT_ID },
          // The database's clock, not the process's: the audit row and the
          // lifecycle event resolve to the same `now()` inside this transaction,
          // so the three cannot disagree by however far two API instances have
          // drifted apart.
          data: expect.objectContaining({
            status: 'suspended',
            suspendedAt: DATABASE_NOW,
          }) as unknown,
        }),
      );
      expect(tenant.status).toBe('suspended');
      expect(tenant.suspendedAt).toEqual(DATABASE_NOW);
    });

    it('starts the retention clock and destroys nothing', async () => {
      await service.deactivate({ slug: SLUG });

      // Deactivation is one row's status plus the timers arriving at
      // `suspended` implies. Anything else written here — a delete, an
      // anonymisation, a cascade — would make this a destructive operation
      // rather than a reversible one.
      expect(update).toHaveBeenCalledTimes(1);

      const [{ data }] = update.mock.calls[0] as [{ data: Record<string, unknown> }];

      expect(Object.keys(data).sort()).toEqual([
        'deletionReminderNotifiedAt',
        'purgeAt',
        'status',
        'suspendedAt',
      ]);
      // 30 days out, not now: the retention window is what stands between a
      // suspension and the one irreversible operation in the product.
      expect(data.purgeAt).toBeInstanceOf(Date);
      expect((data.purgeAt as Date).getTime()).toBeGreaterThan(DATABASE_NOW.getTime());
    });

    it('records the transition in the lifecycle trail, attributed to the operator', async () => {
      await asOperator('ops-alice', () =>
        service.deactivate({ slug: SLUG, reason: 'Non-payment' }),
      );

      expect(createLifecycleEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            fromState: 'active',
            toState: 'suspended',
            // What kind of thing caused the edge, which is a different question
            // from who: an operator pressing a button is not a timer elapsing,
            // and the trail has to be able to tell them apart.
            trigger: 'operator_action',
            actorType: 'platform_operator',
            actorUserId: null,
            actorLabel: 'ops-alice',
            occurredAt: DATABASE_NOW,
            reason: 'Non-payment',
          }) as unknown,
        }),
      );
    });

    it('queues the suspension notice under the audit row’s own id', async () => {
      await service.deactivate({ slug: SLUG });

      const [queue, job, data, options] = enqueue.mock.calls[0] as [
        string,
        string,
        { eventId: string },
        { jobId: string },
      ];

      expect(queue).toBe(TENANCY_QUEUE);
      expect(job).toBe(NOTIFY_TENANT_LIFECYCLE_JOB);
      // Deterministic on the row id, which is what makes a redelivery a
      // duplicate BullMQ discards rather than a second email to every admin —
      // and hyphen-prefixed, because BullMQ refuses an id containing a colon.
      expect(options.jobId).toBe(lifecycleNotificationJobId(data.eventId));
    });

    it('records who lost access and why, in the same transaction as the write', async () => {
      await asOperator('ops-alice', () =>
        service.deactivate({ slug: SLUG, reason: 'Non-payment, ticket OPS-412' }),
      );

      expect(createAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            // The operator credential that authenticated the request (TAR-166),
            // not a user: the platform is never a row in this tenant's `users`.
            actorType: 'platform_operator',
            actorUserId: null,
            actorLabel: 'ops-alice',
            action: TENANT_DEACTIVATED_ACTION,
            targetType: 'tenant',
            targetId: TENANT_ID,
            // Named rather than left to the column default: Prisma generates
            // `@default(now())` itself, so the default never fires and the
            // audit entry would carry the process clock at insert time.
            createdAt: DATABASE_NOW,
            metadata: { reason: 'Non-payment, ticket OPS-412' },
          }) as unknown,
        }),
      );
    });

    it('records the deactivation even when no reason was given', async () => {
      await service.deactivate({ slug: SLUG });

      expect(createAuditLog).toHaveBeenCalledTimes(1);

      const [{ data }] = createAuditLog.mock.calls[0] as [{ data: { metadata?: unknown } }];
      expect(data.metadata).toBeUndefined();
    });

    it('serialises on the slug, so two operators produce one write', async () => {
      await service.deactivate({ slug: SLUG });

      const [fragments, ...values] = executeRaw.mock.calls[0] as [string[], ...unknown[]];

      expect(fragments.join('?')).toContain('pg_advisory_xact_lock');
      expect(values).toEqual([`tenant-deactivation:${SLUG}`]);
    });

    it('also takes the lifecycle lock, so a timer cannot race the operator', async () => {
      await service.deactivate({ slug: SLUG });

      // Two locks in one transaction, keyed differently: this route is
      // identified by slug and the state machine by id, and the sweep only holds
      // the second. Without it a grace period elapsing at the same instant could
      // read the status this call is about to write.
      const keys = executeRaw.mock.calls.map(([, key]: [string[], string]) => key);

      expect(keys).toEqual([`tenant-deactivation:${SLUG}`, `tenant-lifecycle:${TENANT_ID}`]);
    });
  });

  describe('a tenant that is already inaccessible', () => {
    it.each(['suspended', 'cancelled'] as const)('leaves a %s tenant untouched', async (status) => {
      const suspendedAt = new Date('2026-08-01T00:00:00.000Z');
      findUnique.mockResolvedValue({ ...ACTIVE, status, suspendedAt });

      const result = await service.deactivate({ slug: SLUG });

      expect(result.deactivated).toBe(false);
      expect(result.tenant.status).toBe(status);
      // The original stamp survives: it is the record of when access was
      // actually revoked, and a replayed script must not move it.
      expect(result.tenant.suspendedAt).toEqual(suspendedAt);
      expect(update).not.toHaveBeenCalled();
      expect(createAuditLog).not.toHaveBeenCalled();
      expect(createLifecycleEvent).not.toHaveBeenCalled();
      // No second email either. A replayed script must not tell a tenant's
      // admins twice that they have been suspended.
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('a tenant that does not exist', () => {
    it('says so rather than reporting a success', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.deactivate({ slug: 'typo' })).rejects.toBeInstanceOf(
        TenantNotFoundError,
      );
      expect(update).not.toHaveBeenCalled();
    });
  });
});
