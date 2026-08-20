import type { MediaStorage } from '../../media/storage/media-storage.port';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import type { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';
import { TenantPurgeService } from './tenant-purge.service';

/**
 * The one irreversible operation in the product: when it runs, what order it
 * destroys things in, and — the assertions that matter most — every case in
 * which it refuses to run at all.
 *
 * The database is stubbed, so what is covered here is the decision and the
 * sequencing. That the delete order actually satisfies the schema's foreign
 * keys, and that a purge of one tenant touches no row of another, need a real
 * PostgreSQL and are `lifecycle-purge.int-spec.ts`'s.
 */

const TENANT_ID = '5d111111-1111-7111-8111-111111111101';
const NOW = new Date('2026-08-16T12:00:00.000Z');
const ELAPSED = new Date(NOW.getTime() - 60_000);
const NOT_YET = new Date(NOW.getTime() + 60_000);

function suspended(overrides: Record<string, unknown> = {}) {
  return {
    id: TENANT_ID,
    slug: 'acme',
    status: 'suspended',
    purgeAt: ELAPSED,
    purgeStartedAt: null,
    ...overrides,
  };
}

describe('TenantPurgeService', () => {
  let findUniqueTenant: jest.Mock;
  let updateTenant: jest.Mock;
  let findManyMedia: jest.Mock;
  let updateManyWebhooks: jest.Mock;
  let executeRaw: jest.Mock;
  let deleteBlob: jest.Mock;
  let remind: jest.Mock;
  let createEvent: jest.Mock;
  let service: TenantPurgeService;

  beforeEach(() => {
    findUniqueTenant = jest.fn().mockResolvedValue(suspended());
    updateTenant = jest.fn().mockResolvedValue({ id: TENANT_ID });
    findManyMedia = jest.fn().mockResolvedValue([]);
    updateManyWebhooks = jest.fn().mockResolvedValue({ count: 0 });
    // Every table comes back empty, so each is one statement and the loop moves on.
    executeRaw = jest.fn().mockResolvedValue(0);
    deleteBlob = jest.fn().mockResolvedValue(undefined);
    remind = jest.fn().mockResolvedValue(undefined);
    createEvent = jest.fn().mockResolvedValue({ id: 'event' });

    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: jest.fn().mockResolvedValue([{ now: NOW }]),
      tenant: {
        findUnique: findUniqueTenant,
        update: jest.fn().mockResolvedValue({ ...suspended(), status: 'deleted' }),
      },
      lifecycleEvent: { create: createEvent },
    };

    const systemPrisma = {
      $transaction: (work: (client: typeof tx) => Promise<unknown>) => work(tx),
      tenant: { findUnique: findUniqueTenant, update: updateTenant },
      mediaObject: { findMany: findManyMedia },
      webhookEvent: { updateMany: updateManyWebhooks },
    } as unknown as SystemPrisma;

    service = new TenantPurgeService(
      systemPrisma,
      { delete: deleteBlob } as unknown as MediaStorage,
      { remind } as unknown as TenantLifecycleNotifier,
    );
  });

  /** When the first `DELETE` was issued — the line every "before" assertion is against. */
  function firstDelete(): number {
    return executeRaw.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER;
  }

  /**
   * The table names, in the order statements were issued against them.
   *
   * Read off the `Prisma.Sql` the service built, so the assertion is against the
   * statement that would actually be sent rather than against the constant the
   * service happens to hold.
   */
  function deletedTables(): string[] {
    return statementsMatching(/DELETE FROM/);
  }

  /**
   * The tables a statement of `shape` was issued against, in order.
   *
   * DELETE and UPDATE are told apart deliberately: `webhook_events` is
   * **unlinked, not deleted**, and a helper that lumped the two together would
   * let a future change start deleting Meta’s payloads while
   * `expect(order).not.toContain('webhook_events')` still passed.
   */
  function statementsMatching(shape: RegExp): string[] {
    return executeRaw.mock.calls
      .map(([statement]: [unknown]) => JSON.stringify(statement))
      .filter((text: string) => shape.test(text))
      .map((text: string) => text.split('public').at(1) ?? '')
      .map((tail: string) => /[a-z_]{3,}/.exec(tail)?.[0] ?? '')
      .filter((table: string) => table !== '');
  }

  describe('when it refuses to run', () => {
    it('refuses a tenant whose retention window has not elapsed', async () => {
      findUniqueTenant.mockResolvedValue(suspended({ purgeAt: NOT_YET }));

      const report = await service.purge(TENANT_ID, NOW);

      expect(report.purged).toBe(false);
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a tenant that was reactivated after the job was queued', async () => {
      // The check that matters most in this file. A job can sit in Redis across
      // a reactivation, and a purge that ran on a tenant an admin rescued twenty
      // minutes ago is the worst bug this feature can produce.
      findUniqueTenant.mockResolvedValue(suspended({ status: 'active', purgeAt: null }));

      const report = await service.purge(TENANT_ID, NOW);

      expect(report.purged).toBe(false);
      expect(deleteBlob).not.toHaveBeenCalled();
      expect(executeRaw).not.toHaveBeenCalled();
    });

    it('refuses a tenant with no retention window running at all', async () => {
      findUniqueTenant.mockResolvedValue(suspended({ purgeAt: null }));

      expect((await service.purge(TENANT_ID, NOW)).purged).toBe(false);
    });

    it('says so for a tenant that does not exist', async () => {
      findUniqueTenant.mockResolvedValue(null);

      await expect(service.purge(TENANT_ID, NOW)).rejects.toBeInstanceOf(TenantNotFoundError);
    });
  });

  describe('when it runs', () => {
    it('stamps `purge_started_at` and says goodbye before deleting anything', async () => {
      await service.purge(TENANT_ID, NOW);

      expect(updateTenant).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: TENANT_ID },
          data: { purgeStartedAt: expect.any(Date) as Date },
        }),
      );
      // The addresses live in a table this job is about to destroy, so the
      // message is sent while the rows are still there.
      expect(remind).toHaveBeenCalledWith(TENANT_ID, 'tenant_deleted');
      expect(remind.mock.invocationCallOrder[0]).toBeLessThan(firstDelete());
    });

    it('deletes blobs before the rows that point at them', async () => {
      findManyMedia
        .mockResolvedValueOnce([{ id: 'm1', storageKey: 'tenant/a/one' }])
        .mockResolvedValueOnce([]);

      await service.purge(TENANT_ID, NOW);

      // Risk 1 in ADR 0009. A crash between the two then leaves a row pointing
      // at a missing object — findable and fixable — rather than an object
      // nobody points at, which is unfindable because the only pointer is gone.
      expect(deleteBlob).toHaveBeenCalledWith('tenant/a/one');
      expect(deleteBlob.mock.invocationCallOrder[0]).toBeLessThan(firstDelete());
    });

    it('does not let one failed object-store call strand a half-deleted tenant', async () => {
      findManyMedia
        .mockResolvedValueOnce([
          { id: 'm1', storageKey: 'tenant/a/one' },
          { id: 'm2', storageKey: 'tenant/a/two' },
        ])
        .mockResolvedValueOnce([]);
      deleteBlob.mockRejectedValueOnce(new Error('bucket unreachable'));

      const report = await service.purge(TENANT_ID, NOW);

      expect(report.purged).toBe(true);
      expect(report.blobsDeleted).toBe(1);
    });

    it('deletes children before parents, deepest table first', async () => {
      await service.purge(TENANT_ID, NOW);

      const order = deletedTables();

      // A handful of pairs, each one a foreign key that would refuse the
      // delete if the order were the other way round.
      expect(order.indexOf('message_attachments')).toBeLessThan(order.indexOf('messages'));
      expect(order.indexOf('messages')).toBeLessThan(order.indexOf('conversations'));
      expect(order.indexOf('ticket_events')).toBeLessThan(order.indexOf('tickets'));
      expect(order.indexOf('audit_logs')).toBeLessThan(order.indexOf('users'));
      expect(order.indexOf('team_members')).toBeLessThan(order.indexOf('teams'));
      expect(order.indexOf('contact_tags')).toBeLessThan(order.indexOf('contacts'));
    });

    it('keeps the slug tombstone and the trail, and unlinks Meta’s payloads', async () => {
      await service.purge(TENANT_ID, NOW);

      const order = deletedTables();

      // Releasing `acme` would let a new tenant inherit the dead one's
      // bookmarks, cached sessions and any Meta webhook still routing a
      // `phone_number_id` that used to be theirs.
      expect(order).not.toContain('tenants');
      // The audit trail TAR-36's sixth criterion asks for. Nothing cascades into
      // it, and nothing here deletes from it.
      expect(order).not.toContain('lifecycle_events');
      expect(order).not.toContain('webhook_events');
      // Unlinked, not deleted — and in batches, because `webhook_events` is the
      // highest-volume table in the product and a single UPDATE across a busy
      // tenant's whole history is the statement that exceeds the 30-second
      // server-side `statement_timeout`. It is the *last* statement of the
      // purge, so a cancellation there strands the tenant half-deleted.
      expect(statementsMatching(/UPDATE/)).toEqual(['webhook_events']);
      expect(JSON.stringify(executeRaw.mock.calls)).toContain('LIMIT');
    });

    it('writes the transition to `deleted` only after the last batch', async () => {
      await service.purge(TENANT_ID, NOW);

      expect(createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            toState: 'deleted',
            // One road to `deleted` and one clock on it.
            trigger: 'timer',
            actorType: 'system',
          }) as unknown,
        }),
      );
      expect(createEvent.mock.invocationCallOrder[0]).toBeGreaterThan(
        executeRaw.mock.invocationCallOrder.at(-1) ?? 0,
      );
    });

    it('resumes rather than restarting when a previous attempt crashed', async () => {
      findUniqueTenant.mockResolvedValue(suspended({ purgeStartedAt: ELAPSED }));

      await service.purge(TENANT_ID, NOW);

      // The stamp is what distinguishes a half-purged tenant from a queued one,
      // and what stops a second `tenant_deleted` message going out.
      expect(updateTenant).not.toHaveBeenCalled();
      expect(remind).not.toHaveBeenCalled();
      expect(executeRaw).toHaveBeenCalled();
    });
  });
});
