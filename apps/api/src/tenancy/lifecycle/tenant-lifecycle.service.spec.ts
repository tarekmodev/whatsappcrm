import type { BillingEvent, TenantStatus } from '@whatsappcrm/contracts';
import type { AuditActor } from '../../audit/audit-actor';
import type { Prisma } from '../../generated/prisma/client';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { NOTIFY_TENANT_LIFECYCLE_JOB, TENANCY_QUEUE } from '../../queue/queue.constants';
import type { QueueService } from '../../queue/queue.service';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import { InvalidTenantTransitionError } from './tenant-lifecycle.errors';
import { lifecycleNotificationJobId } from './lifecycle-jobs';
import { TenantLifecycleService } from './tenant-lifecycle.service';

/**
 * The single writer of `tenants.status`: what it writes, what it refuses, and
 * what it does after the commit.
 *
 * The database is stubbed. Which edges are legal is
 * `tenant-lifecycle.state.spec.ts`'s subject and is not re-derived here; what
 * this file covers is the behaviour around that decision — the lock, the
 * idempotence, the audit row, the notification, and the two things that must
 * happen in one transaction.
 */

const TENANT_ID = '5a444444-4444-7444-8444-4444444444a1';
const DATABASE_NOW = new Date('2026-08-16T12:00:00.000Z');

const OPERATOR: AuditActor = {
  actorType: 'platform_operator',
  actorUserId: null,
  actorLabel: 'ops-alice',
};

const SYSTEM: AuditActor = { actorType: 'system', actorUserId: null, actorLabel: null };

function tenantAt(status: TenantStatus) {
  return {
    id: TENANT_ID,
    slug: 'acme',
    name: 'Acme Ltd',
    status,
    trialEndsAt: null,
    gracePeriodEndsAt: null,
    suspendedAt: null,
    cancelledAt: null,
    purgeAt: null,
    purgeStartedAt: null,
    deletedAt: null,
  };
}

function billingEvent(type: BillingEvent['type']): BillingEvent {
  return {
    type,
    tenantId: TENANT_ID,
    providerEventId: 'evt_polar_1',
    planKey: 'growth',
    seats: 5,
    status: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    occurredAt: DATABASE_NOW.toISOString(),
  };
}

describe('TenantLifecycleService', () => {
  let findUnique: jest.Mock;
  let update: jest.Mock;
  let createEvent: jest.Mock;
  let executeRaw: jest.Mock;
  let enqueue: jest.Mock;
  let service: TenantLifecycleService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(tenantAt('active'));
    update = jest
      .fn()
      .mockImplementation(({ data }: { data: { status: TenantStatus } }) =>
        Promise.resolve({ ...tenantAt(data.status) }),
      );
    createEvent = jest.fn().mockResolvedValue({ id: 'event' });
    executeRaw = jest.fn().mockResolvedValue(1);
    enqueue = jest.fn().mockResolvedValue('added');

    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: jest.fn().mockResolvedValue([{ now: DATABASE_NOW }]),
      tenant: { findUnique, update },
      lifecycleEvent: { create: createEvent },
    } as unknown as Prisma.TransactionClient;

    const systemPrisma = {
      $transaction: (work: (tx: Prisma.TransactionClient) => Promise<unknown>) => work(tx),
      tenant: { findUnique },
    } as unknown as SystemPrisma;

    service = new TenantLifecycleService(systemPrisma, { enqueue } as unknown as QueueService);
  });

  /** The `data` the tenant row was updated with, for the assertions below. */
  function writtenColumns(): Record<string, unknown> {
    const [{ data }] = update.mock.calls[0] as [{ data: Record<string, unknown> }];

    return data;
  }

  describe('a legal transition', () => {
    it('writes the status, the trail and the timers in one transaction', async () => {
      const result = await service.transition({
        tenantId: TENANT_ID,
        to: 'cancelled',
        trigger: 'operator_action',
        actor: OPERATOR,
        reason: 'Fraud, chargeback OPS-88',
      });

      expect(result.transitioned).toBe(true);
      expect(result.state.status).toBe('cancelled');
      expect(writtenColumns()).toMatchObject({ status: 'cancelled', cancelledAt: DATABASE_NOW });
      expect(createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            tenantId: TENANT_ID,
            fromState: 'active',
            toState: 'cancelled',
            trigger: 'operator_action',
            actorType: 'platform_operator',
            actorLabel: 'ops-alice',
            occurredAt: DATABASE_NOW,
            reason: 'Fraud, chargeback OPS-88',
          }) as unknown,
        }),
      );
    });

    it('stamps both rows from the database clock, not the process clock', async () => {
      await service.transition({
        tenantId: TENANT_ID,
        to: 'cancelled',
        trigger: 'user_action',
        actor: SYSTEM,
      });

      const [{ data: event }] = createEvent.mock.calls[0] as [{ data: { occurredAt: Date } }];

      // Two API instances a few seconds apart would otherwise be able to order
      // the trail inconsistently with the row it describes.
      expect(event.occurredAt).toEqual(DATABASE_NOW);
      expect(writtenColumns().cancelledAt).toEqual(DATABASE_NOW);
    });

    it('serialises on the tenant, so two callers cannot both read the old status', async () => {
      await service.transition({
        tenantId: TENANT_ID,
        to: 'cancelled',
        trigger: 'user_action',
        actor: SYSTEM,
      });

      const [fragments, key] = executeRaw.mock.calls[0] as [string[], string];

      expect(fragments.join('?')).toContain('pg_advisory_xact_lock');
      expect(key).toBe(`tenant-lifecycle:${TENANT_ID}`);
    });

    it('records a `reason` of null rather than omitting it', async () => {
      await service.transition({
        tenantId: TENANT_ID,
        to: 'cancelled',
        trigger: 'user_action',
        actor: SYSTEM,
      });

      const [{ data }] = createEvent.mock.calls[0] as [{ data: { reason: string | null } }];

      expect(data.reason).toBeNull();
    });
  });

  describe('the notification', () => {
    it('is enqueued after the commit, under the audit row’s own id', async () => {
      const result = await service.transition({
        tenantId: TENANT_ID,
        to: 'suspended',
        trigger: 'operator_action',
        actor: OPERATOR,
      });

      expect(enqueue).toHaveBeenCalledWith(
        TENANCY_QUEUE,
        NOTIFY_TENANT_LIFECYCLE_JOB,
        { tenantId: TENANT_ID, eventId: result.eventId },
        expect.objectContaining({
          jobId: lifecycleNotificationJobId(result.eventId ?? ''),
          // Without `attempts` BullMQ tries once, and one transient mailer
          // failure would be terminal for this notice.
          attempts: 3,
        }) as unknown,
      );
    });

    it('does not fail the transition when the queue is unavailable', async () => {
      // The row is the truth and the queue is an accelerator. A Redis outage
      // that rolled back a suspension would leave a tenant that should have been
      // locked out still running — the wrong failure.
      enqueue.mockResolvedValue('unavailable');

      const result = await service.transition({
        tenantId: TENANT_ID,
        to: 'suspended',
        trigger: 'operator_action',
        actor: OPERATOR,
      });

      expect(result.transitioned).toBe(true);
      expect(result.eventId).not.toBeNull();
    });
  });

  describe('idempotence', () => {
    it('writes nothing when the tenant is already in the target state', async () => {
      findUnique.mockResolvedValue(tenantAt('suspended'));

      const result = await service.transition({
        tenantId: TENANT_ID,
        to: 'suspended',
        trigger: 'timer',
        actor: SYSTEM,
      });

      expect(result.transitioned).toBe(false);
      expect(result.eventId).toBeNull();
      expect(update).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
      // No second email, and — the one that matters — no re-stamped
      // `suspended_at` or re-dated `purge_at`. A replayed sweep must not move
      // the clock that destroys data.
      expect(enqueue).not.toHaveBeenCalled();
    });

    it('returns the state it found, so a caller can render it either way', async () => {
      findUnique.mockResolvedValue({ ...tenantAt('suspended'), purgeAt: DATABASE_NOW });

      const result = await service.transition({
        tenantId: TENANT_ID,
        to: 'suspended',
        trigger: 'timer',
        actor: SYSTEM,
      });

      expect(result.state.purgeAt).toEqual(DATABASE_NOW);
    });
  });

  describe('refusals', () => {
    it('refuses an edge the state machine does not have', async () => {
      findUnique.mockResolvedValue(tenantAt('deleted'));

      await expect(
        service.transition({
          tenantId: TENANT_ID,
          to: 'active',
          trigger: 'operator_action',
          actor: OPERATOR,
        }),
      ).rejects.toBeInstanceOf(InvalidTenantTransitionError);

      expect(update).not.toHaveBeenCalled();
      expect(createEvent).not.toHaveBeenCalled();
    });

    it('refuses a legal edge caused by the wrong thing', async () => {
      const refusal = await service
        .transition({
          tenantId: TENANT_ID,
          to: 'past_due',
          trigger: 'user_action',
          actor: SYSTEM,
        })
        .catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(InvalidTenantTransitionError);
      expect((refusal as InvalidTenantTransitionError).reason).toBe('trigger_not_allowed');
    });

    it('says so for a tenant that does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(
        service.transition({
          tenantId: TENANT_ID,
          to: 'cancelled',
          trigger: 'user_action',
          actor: SYSTEM,
        }),
      ).rejects.toBeInstanceOf(TenantNotFoundError);
    });
  });

  describe('applyBillingEvent — TAR-37’s entry point, implemented now', () => {
    it.each([
      ['payment.failed', 'past_due'],
      ['subscription.past_due', 'past_due'],
    ] as const)('moves an active tenant to %s → %s', async (type, expected) => {
      await service.applyBillingEvent(billingEvent(type));

      expect(writtenColumns().status).toBe(expected);
    });

    it.each(['subscription.activated', 'payment.succeeded'] as const)(
      'brings a past_due tenant back on %s',
      async (type) => {
        findUnique.mockResolvedValue(tenantAt('past_due'));

        await service.applyBillingEvent(billingEvent(type));

        expect(writtenColumns()).toMatchObject({ status: 'active', gracePeriodEndsAt: null });
      },
    );

    it('cancels on `subscription.canceled`', async () => {
      await service.applyBillingEvent(billingEvent('subscription.canceled'));

      expect(writtenColumns().status).toBe('cancelled');
    });

    it('records the provider event id and nothing else about the payment', async () => {
      await service.applyBillingEvent(billingEvent('payment.failed'));

      const [{ data }] = createEvent.mock.calls[0] as [
        { data: { trigger: string; metadata: Record<string, string> } },
      ];

      expect(data.trigger).toBe('billing_event');
      // Never a payment instrument, never a token, never a customer record.
      expect(data.metadata).toEqual({
        providerEventId: 'evt_polar_1',
        billingEventType: 'payment.failed',
      });
    });

    it('treats `subscription.updated` as a plan change, not a lifecycle edge', async () => {
      // A routine upgrade must not become a transition with an email attached.
      const result = await service.applyBillingEvent(billingEvent('subscription.updated'));

      expect(result.transitioned).toBe(false);
      expect(update).not.toHaveBeenCalled();
    });

    it('drops an event that does not apply rather than failing the webhook', async () => {
      // `payment.failed` for a tenant an operator cancelled an hour ago is late
      // news, not an error. Throwing would make the provider retry an event that
      // will never become applicable.
      findUnique.mockResolvedValue(tenantAt('deleted'));

      const result = await service.applyBillingEvent(billingEvent('payment.failed'));

      expect(result.transitioned).toBe(false);
      expect(createEvent).not.toHaveBeenCalled();
    });

    it('is a no-op on replay, because the tenant is already where it was moved to', async () => {
      findUnique.mockResolvedValue(tenantAt('past_due'));

      const result = await service.applyBillingEvent(billingEvent('payment.failed'));

      expect(result.transitioned).toBe(false);
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  describe('state()', () => {
    it('reports the lifecycle columns as they stand', async () => {
      findUnique.mockResolvedValue({ ...tenantAt('suspended'), purgeAt: DATABASE_NOW });

      const state = await service.state(TENANT_ID);

      expect(state).toMatchObject({ status: 'suspended', purgeAt: DATABASE_NOW });
    });

    it('says so for a tenant that does not exist', async () => {
      findUnique.mockResolvedValue(null);

      await expect(service.state(TENANT_ID)).rejects.toBeInstanceOf(TenantNotFoundError);
    });
  });
});
