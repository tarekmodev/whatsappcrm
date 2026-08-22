import type { OutboundEmail, TenantStatus } from '@whatsappcrm/contracts';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { LifecycleEventNotFoundError } from './tenant-lifecycle.errors';
import { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';

/**
 * Which email a transition sends, who it goes to, and what stops it going twice.
 *
 * ADR 0009 decision 7's table is the specification, and it is worth testing as a
 * table: the failure mode of an unmapped transition is a tenant that is
 * suspended and never told, which nothing else in the system notices.
 */

const EVENT_ID = '5e111111-1111-7111-8111-1111111111e1';
const TENANT_ID = '5e111111-1111-7111-8111-111111111101';

function eventFor(from: TenantStatus | null, to: TenantStatus, notifiedAt: Date | null = null) {
  return { id: EVENT_ID, tenantId: TENANT_ID, fromState: from, toState: to, notifiedAt };
}

describe('TenantLifecycleNotifier', () => {
  let findUniqueEvent: jest.Mock;
  let updateManyEvents: jest.Mock;
  let findManyUsers: jest.Mock;
  let send: jest.Mock;
  let notifier: TenantLifecycleNotifier;

  beforeEach(() => {
    findUniqueEvent = jest.fn().mockResolvedValue(eventFor('active', 'suspended'));
    updateManyEvents = jest.fn().mockResolvedValue({ count: 1 });
    findManyUsers = jest
      .fn()
      .mockResolvedValue([{ email: 'owner@acme.invalid' }, { email: 'ops@acme.invalid' }]);
    send = jest.fn().mockResolvedValue(undefined);

    const systemPrisma = {
      lifecycleEvent: { findUnique: findUniqueEvent, updateMany: updateManyEvents },
      user: { findMany: findManyUsers },
    } as unknown as SystemPrisma;

    notifier = new TenantLifecycleNotifier(systemPrisma, { send });
  });

  /** The templates the mailer was actually asked for. */
  function sentTemplates(): string[] {
    return send.mock.calls.map(([message]: [OutboundEmail]) => message.template);
  }

  describe('which template a transition sends', () => {
    it.each([
      // `from` is null on the genesis row provisioning writes, which is the
      // production producer of `tenant_welcome` (TAR-598). Every entry is keyed
      // on the arrival, so `created` reaches the same answer — that is the shape
      // a tenant left in `created` by a half-applied provision would take.
      [null, 'trialing', 'tenant_welcome'],
      ['created', 'trialing', 'tenant_welcome'],
      ['trialing', 'past_due', 'trial_expired'],
      ['active', 'past_due', 'payment_failed'],
      ['active', 'cancelled', 'tenant_cancelled'],
      ['past_due', 'suspended', 'tenant_suspended'],
      ['suspended', 'active', 'tenant_reactivated'],
      ['past_due', 'active', 'tenant_reactivated'],
      ['cancelled', 'active', 'tenant_reactivated'],
    ] as const)('sends %s → %s as `%s`', async (from, to, template) => {
      findUniqueEvent.mockResolvedValue(eventFor(from, to));

      await notifier.notify(EVENT_ID);

      expect(sentTemplates()).toEqual([template, template]);
    });

    it('tells a trial running out from a card failing, on the same arrival', async () => {
      // The one entry in 0009's table that depends on where the tenant came
      // from. They are the same state and completely different emails.
      findUniqueEvent.mockResolvedValue(eventFor('trialing', 'past_due'));
      await notifier.notify(EVENT_ID);
      expect(sentTemplates()).toContain('trial_expired');

      send.mockClear();
      updateManyEvents.mockResolvedValue({ count: 1 });
      findUniqueEvent.mockResolvedValue(eventFor('active', 'past_due'));
      await notifier.notify(EVENT_ID);
      expect(sentTemplates()).toContain('payment_failed');
    });

    it.each([null, 'created'] as const)(
      'sends nothing for a %s → active genesis row, which is an operator provisioning a tenant',
      async (from) => {
        // There is no admin yet, and the operator is the one who knows.
        findUniqueEvent.mockResolvedValue(eventFor(from, 'active'));

        await notifier.notify(EVENT_ID);

        expect(send).not.toHaveBeenCalled();
      },
    );

    it('sends nothing for a trial converting, which is billing’s receipt to send', async () => {
      findUniqueEvent.mockResolvedValue(eventFor('trialing', 'active'));

      await notifier.notify(EVENT_ID);

      expect(send).not.toHaveBeenCalled();
    });

    it('leaves `tenant_deleted` to the purge, which reads the addresses first', async () => {
      // By the time the `→ deleted` transition is written, `users` has been
      // emptied — so there is nobody left to address it to. The row is still
      // claimed, or the backstop re-queues a job with nothing to do for ever.
      findUniqueEvent.mockResolvedValue(eventFor('suspended', 'deleted'));

      await notifier.notify(EVENT_ID);

      expect(send).not.toHaveBeenCalled();
      expect(updateManyEvents).toHaveBeenCalled();
    });
  });

  describe('who it goes to', () => {
    it('addresses every active admin, and only them', async () => {
      await notifier.notify(EVENT_ID);

      expect(findManyUsers).toHaveBeenCalledWith({
        where: { tenantId: TENANT_ID, role: 'admin', status: 'active' },
        select: { email: true },
      });
      expect(send.mock.calls.map(([message]: [OutboundEmail]) => message.to)).toEqual([
        'owner@acme.invalid',
        'ops@acme.invalid',
      ]);
    });

    it('carries the tenant, and no credential', async () => {
      await notifier.notify(EVENT_ID);

      const [message] = send.mock.calls[0] as [OutboundEmail];

      expect(message.tenantId).toBe(TENANT_ID);
      // A lifecycle notice carries no token and no link path: the console is
      // reached at the tenant's own address, which the adapter resolves.
      expect(message.data).toEqual({});
    });

    it('says so, rather than failing, when a tenant has no admin left', async () => {
      // Risk 3 in ADR 0009: a tenant whose only admin left the company is
      // suspended and then purged without an email reaching a human. Nothing in
      // this story fixes that; what it must not do is turn it into a failed job
      // that retries for ever.
      findManyUsers.mockResolvedValue([]);

      await expect(notifier.notify(EVENT_ID)).resolves.toBeUndefined();
      expect(send).not.toHaveBeenCalled();
    });

    it('does not let one bad address cost every other admin their notice', async () => {
      send.mockRejectedValueOnce(new Error('mailbox full'));

      await expect(notifier.notify(EVENT_ID)).resolves.toBeUndefined();
      expect(send).toHaveBeenCalledTimes(2);
    });
  });

  describe('what stops it sending twice', () => {
    it('returns early for a row that is already stamped', async () => {
      findUniqueEvent.mockResolvedValue(eventFor('active', 'suspended', new Date()));

      await notifier.notify(EVENT_ID);

      expect(updateManyEvents).not.toHaveBeenCalled();
      expect(send).not.toHaveBeenCalled();
    });

    it('claims the stamp conditionally, so two workers produce one send', async () => {
      await notifier.notify(EVENT_ID);

      // A read followed by a write has a window two workers race in, and the bug
      // it produces is a duplicate email to every admin in the tenant.
      expect(updateManyEvents).toHaveBeenCalledWith({
        where: { id: EVENT_ID, notifiedAt: null },
        data: { notifiedAt: expect.any(Date) as Date },
      });
    });

    it('sends nothing when another worker won the claim', async () => {
      updateManyEvents.mockResolvedValue({ count: 0 });

      await notifier.notify(EVENT_ID);

      expect(send).not.toHaveBeenCalled();
    });

    it('claims before it sends, because a mail loop is worse than a lost notice', async () => {
      await notifier.notify(EVENT_ID);

      expect(updateManyEvents.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
        send.mock.invocationCallOrder[0] ?? 0,
      );
    });
  });

  it('says so when the row a job names is gone', async () => {
    // Unreachable — `lifecycle_events` is append-only and nothing deletes from
    // it — and said out loud rather than treated as "nothing to send", because
    // the two are different and only one of them is a bug.
    findUniqueEvent.mockResolvedValue(null);

    await expect(notifier.notify(EVENT_ID)).rejects.toBeInstanceOf(LifecycleEventNotFoundError);
  });

  describe('the two timer reminders', () => {
    it('sends `trial_ending` to the same recipients, with no event row involved', async () => {
      await notifier.remind(TENANT_ID, 'trial_ending');

      expect(sentTemplates()).toEqual(['trial_ending', 'trial_ending']);
      // The sweep owns their once-only-ness, through the two `tenants` columns.
      expect(updateManyEvents).not.toHaveBeenCalled();
    });

    it('sends `deletion_reminder` the same way', async () => {
      await notifier.remind(TENANT_ID, 'deletion_reminder');

      expect(sentTemplates()).toEqual(['deletion_reminder', 'deletion_reminder']);
    });
  });
});
