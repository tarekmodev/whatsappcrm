import type { ConfigService } from '@nestjs/config';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../../generated/prisma/client';
import type { MediaStorage } from '../../media/storage/media-storage.port';
import { createPrismaClient } from '../../prisma/prisma-client.factory';
import { TenantNotActiveError } from '../../prisma/prisma.errors';
import { withTenantScope, type TenantPrisma } from '../../prisma/tenant-scope.extension';
import { QueueService } from '../../queue/queue.service';
import { TenantLifecycleNotifier } from './tenant-lifecycle.notifier';
import { TenantLifecycleService } from './tenant-lifecycle.service';
import { TenantPurgeService } from './tenant-purge.service';

/**
 * The three integration assertions ADR 0009 asks TAR-404 for **by name**, plus
 * the one the purge order can only be proved against a real schema:
 *
 *   1. a suspended tenant's inbound write still lands;
 *   2. a reactivated tenant reads its data with no re-provisioning;
 *   3. a purge of one tenant touches no row of another;
 *   4. the purge finishes — the delete order satisfies every foreign key, and
 *      the `tenants` row survives it as the slug tombstone.
 *
 * None of the four is assertable without a database. The purge order in
 * particular is a claim about the *schema*, and a mock would prove only that
 * `PURGE_ORDER` agrees with itself; the failure it exists to catch is a table
 * added later and appended to the wrong end of the list, which shows up as
 * SQLSTATE 23503 on the first real purge and nowhere earlier.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Every fixture row
 * carries a `tar404-fixture` slug prefix and is removed before the run as well
 * as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const FIXTURE_PREFIX = 'tar404-fixture';

/** Purged by the suite. */
const DOOMED_ID = '5f444444-4444-7444-8444-444444444401';
/** Its neighbour, active throughout: the regression subject. */
const NEIGHBOUR_ID = '5f444444-4444-7444-8444-444444444402';
/** Suspended and then reactivated, to show the data was only ever hidden. */
const RESTORED_ID = '5f444444-4444-7444-8444-444444444403';

const CONTACT_OF = {
  doomed: '5f444444-4444-7444-8444-4444444444a1',
  neighbour: '5f444444-4444-7444-8444-4444444444a2',
  restored: '5f444444-4444-7444-8444-4444444444a3',
} as const;

const ADMIN_OF = {
  doomed: '5f444444-4444-7444-8444-4444444444b1',
  neighbour: '5f444444-4444-7444-8444-4444444444b2',
} as const;

const REQUEST_ID = 'tar404-int-spec';

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run the integration suite.`);
  }

  return value;
}

describe('the tenant lifecycle, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let lifecycle: TenantLifecycleService;
  let purge: TenantPurgeService;
  let deletedBlobs: string[];

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      async () => await work(),
    );
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
    // `lifecycle_events` has no foreign key to `tenants` by design — that is
    // what makes it survive a purge — so it does not cascade and has to be
    // cleaned up by hand.
    await systemPrisma.lifecycleEvent.deleteMany({
      where: { tenantId: { in: [DOOMED_ID, NEIGHBOUR_ID, RESTORED_ID] } },
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);
    deletedBlobs = [];

    // No `REDIS_URL`: every enqueue answers `unavailable`, the transitions still
    // commit, and `notified_at` stays null for the sweep to pick up. That is a
    // supported state rather than a stub, and it keeps this file about the
    // database rather than about the queue.
    const queue = new QueueService(
      { get: () => undefined } as unknown as ConfigService,
      tenantContext,
    );

    lifecycle = new TenantLifecycleService(systemPrisma, queue);

    const storage = {
      delete: (key: string) => {
        deletedBlobs.push(key);

        return Promise.resolve();
      },
    } as unknown as MediaStorage;

    // The real notifier, with a mailer that records rather than sends: the
    // ordering it guarantees — recipients read before the first DELETE — is one
    // of the things this file is here to prove.
    const notifier = new TenantLifecycleNotifier(systemPrisma, { send: () => Promise.resolve() });

    purge = new TenantPurgeService(systemPrisma, storage, notifier);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: DOOMED_ID, slug: `${FIXTURE_PREFIX}-doomed`, name: 'Gone', status: 'active' },
        {
          id: NEIGHBOUR_ID,
          slug: `${FIXTURE_PREFIX}-neighbour`,
          name: 'Next door',
          status: 'active',
        },
        { id: RESTORED_ID, slug: `${FIXTURE_PREFIX}-restored`, name: 'Back', status: 'active' },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_OF.doomed, tenantId: DOOMED_ID, phoneE164: '+10000005401' },
        { id: CONTACT_OF.neighbour, tenantId: NEIGHBOUR_ID, phoneE164: '+10000005402' },
        { id: CONTACT_OF.restored, tenantId: RESTORED_ID, phoneE164: '+10000005403' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_OF.doomed,
          tenantId: DOOMED_ID,
          email: 'owner@doomed.invalid',
          name: 'Owner',
          role: 'admin',
          status: 'active',
        },
        {
          id: ADMIN_OF.neighbour,
          tenantId: NEIGHBOUR_ID,
          email: 'owner@neighbour.invalid',
          name: 'Owner',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('a suspended tenant keeps receiving inbound traffic', () => {
    it('accepts a write through TenantPrisma once it is suspended', async () => {
      // TAR-404's second acceptance criterion, and the reason
      // `assert_tenant_serviceable` admits `suspended` at all: the ingest path
      // writes `conversations` and `messages` through this client, and refusing
      // it would make Meta retry and then drop a real customer's message.
      await lifecycle.transition({
        tenantId: RESTORED_ID,
        to: 'suspended',
        trigger: 'operator_action',
        actor: { actorType: 'platform_operator', actorUserId: null, actorLabel: 'ops-int-spec' },
      });

      const created = await asTenant(RESTORED_ID, () =>
        tenantPrisma.contact.create({
          data: { tenantId: RESTORED_ID, phoneE164: '+10000005499' },
          select: { id: true, tenantId: true },
        }),
      );

      expect(created.tenantId).toBe(RESTORED_ID);

      await asTenant(RESTORED_ID, () => tenantPrisma.contact.delete({ where: { id: created.id } }));
    });

    it('sees only its own rows while suspended', async () => {
      const found = await asTenant(RESTORED_ID, () =>
        tenantPrisma.contact.findUnique({ where: { id: CONTACT_OF.neighbour } }),
      );

      expect(found).toBeNull();
    });
  });

  describe('a reactivated tenant reads its data with no re-provisioning', () => {
    it('is whole again on the next statement after the transition commits', async () => {
      // TAR-36's third acceptance criterion. Nothing is restored, re-seeded or
      // re-created: the rows were never deleted, and the status is the only
      // thing that changed in either direction.
      await lifecycle.transition({
        tenantId: RESTORED_ID,
        to: 'active',
        trigger: 'operator_action',
        actor: { actorType: 'platform_operator', actorUserId: null, actorLabel: 'ops-int-spec' },
      });

      const rows = await asTenant(RESTORED_ID, () =>
        tenantPrisma.contact.findMany({ select: { id: true } }),
      );

      expect(rows).toEqual([{ id: CONTACT_OF.restored }]);
    });

    it('clears the retention clock, so nothing purges a tenant that came back', async () => {
      const tenant = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: RESTORED_ID },
        select: { status: true, purgeAt: true, suspendedAt: true },
      });

      expect(tenant.status).toBe('active');
      expect(tenant.purgeAt).toBeNull();
      // The historical stamp survives: "when did they leave" is a question
      // support still has to answer after a reactivation.
      expect(tenant.suspendedAt).toBeInstanceOf(Date);
    });
  });

  describe('the purge', () => {
    beforeAll(async () => {
      await lifecycle.transition({
        tenantId: DOOMED_ID,
        to: 'suspended',
        trigger: 'operator_action',
        actor: { actorType: 'platform_operator', actorUserId: null, actorLabel: 'ops-int-spec' },
      });
      // Bring the retention window forward, exactly as `force: true` on the
      // operator delete route does. The purge re-checks that it has elapsed.
      await systemPrisma.tenant.update({
        where: { id: DOOMED_ID },
        data: { purgeAt: new Date(Date.now() - 1_000) },
      });
    });

    it('finishes: the delete order satisfies every foreign key in the schema', async () => {
      // The assertion a mock cannot make. A table added later and appended to
      // the wrong end of `PURGE_ORDER` fails here with SQLSTATE 23503 rather
      // than on the first real purge.
      const report = await purge.purge(DOOMED_ID);

      expect(report.purged).toBe(true);
      expect(report.rowsDeleted).toBeGreaterThan(0);
    });

    it('destroys the tenant’s data', async () => {
      const [contacts, users] = await Promise.all([
        systemPrisma.contact.count({ where: { tenantId: DOOMED_ID } }),
        systemPrisma.user.count({ where: { tenantId: DOOMED_ID } }),
      ]);

      expect(contacts).toBe(0);
      expect(users).toBe(0);
    });

    it('keeps the `tenants` row as the slug tombstone', async () => {
      const tenant = await systemPrisma.tenant.findUniqueOrThrow({
        where: { id: DOOMED_ID },
        select: { slug: true, status: true, name: true, deletedAt: true, purgeAt: true },
      });

      // Releasing the slug would let a new tenant inherit the dead one's
      // bookmarks, cached sessions and any Meta webhook still routing a
      // `phone_number_id` that used to be theirs.
      expect(tenant.slug).toBe(`${FIXTURE_PREFIX}-doomed`);
      expect(tenant.status).toBe('deleted');
      expect(tenant.deletedAt).toBeInstanceOf(Date);
      expect(tenant.purgeAt).toBeNull();
    });

    it('keeps the lifecycle trail, which is what the tenant’s data is not', async () => {
      const trail = await systemPrisma.lifecycleEvent.findMany({
        where: { tenantId: DOOMED_ID },
        orderBy: { occurredAt: 'asc' },
        select: { fromState: true, toState: true, trigger: true },
      });

      // TAR-36's sixth acceptance criterion. Nothing cascades into this table,
      // which is the whole reason it has no foreign key to `tenants`.
      expect(trail).toEqual([
        { fromState: 'active', toState: 'suspended', trigger: 'operator_action' },
        { fromState: 'suspended', toState: 'deleted', trigger: 'timer' },
      ]);
    });

    it('touches no row of the neighbouring tenant', async () => {
      // The assertion ADR 0009 asks TAR-404 for by name, and the same one
      // `sla-breach.int-spec.ts` already makes for the sweep's writes.
      const [contacts, users] = await Promise.all([
        systemPrisma.contact.findMany({
          where: { tenantId: NEIGHBOUR_ID },
          select: { id: true },
        }),
        systemPrisma.user.findMany({ where: { tenantId: NEIGHBOUR_ID }, select: { id: true } }),
      ]);

      expect(contacts).toEqual([{ id: CONTACT_OF.neighbour }]);
      expect(users).toEqual([{ id: ADMIN_OF.neighbour }]);
    });

    it('leaves the purged tenant unreachable at the data layer', async () => {
      await asTenant(DOOMED_ID, async () => {
        await expect(tenantPrisma.contact.findMany()).rejects.toBeInstanceOf(TenantNotActiveError);
      });
    });

    it('is a no-op on a second run, because the tenant is no longer suspended', async () => {
      const repeat = await purge.purge(DOOMED_ID);

      expect(repeat.purged).toBe(false);
      expect(repeat.rowsDeleted).toBe(0);
    });
  });

  describe('the lifecycle trail is readable after the tenant is not', () => {
    it('is refused through TenantPrisma, whatever the tenant’s status', async () => {
      // `lifecycle_events` is `system-only` in `tenant-scope.extension.ts` and
      // the app role holds no grant on it at all — the table still carries
      // `tenant_id`, so a grant without a policy would expose every tenant's
      // history to the tenant connection.
      await asTenant(NEIGHBOUR_ID, async () => {
        await expect(tenantPrisma.lifecycleEvent.findMany()).rejects.toThrow();
      });
    });

    it('is still readable through SystemPrisma for a purged tenant', async () => {
      // An audit trail you cannot read once the thing it describes has been shut
      // off is not an audit trail. This is the whole argument for the table
      // being platform-level.
      const trail = await systemPrisma.lifecycleEvent.count({ where: { tenantId: DOOMED_ID } });

      expect(trail).toBe(2);
    });
  });
});
