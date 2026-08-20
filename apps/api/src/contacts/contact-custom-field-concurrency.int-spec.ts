import type { ContactResponse, CustomFieldValues } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope } from '../prisma/tenant-scope.extension';
import { ContactsService } from './contacts.service';

/**
 * TAR-530: two agents editing **different** custom fields on the same contact,
 * against a real PostgreSQL.
 *
 * `ContactsService.update` computes the stored map in JavaScript from a row it
 * read earlier in the same transaction. Under `READ COMMITTED` — which is what
 * `$tenantTransaction` runs at — a read takes a fresh snapshot per statement and
 * takes no lock, so without the row lock `lockContact` takes both writers read
 * the same map, the second one's `UPDATE` waits on the first one's row lock, and
 * then overwrites it with a map computed before the first write existed. One key
 * disappears and both requests answer `200`.
 *
 * That is not a property a unit test can state: the fake in
 * `contacts.service.spec.ts` has one caller, no snapshots and no locks. It needs
 * two real transactions on two real connections, so it lives here.
 *
 * The first case is **deterministic rather than racy**, which matters for a
 * regression test — a `Promise.all` of two requests reproduces the bug only
 * sometimes, and a test that passes by timing is not a test. A competing
 * transaction is held open until the writer under test is provably blocked on
 * *that* transaction — an ungranted lock naming the holder's own transaction id, not a
 * cluster-wide "is anyone waiting" — and only then committed. Without the fix
 * that writer has already taken its stale read by the time it blocks, and the
 * assertion fails every run.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. One fixture tenant
 * carrying fixed ids, deleted before the run as well as after it, so an
 * interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '53088888-8888-7888-8888-888888888801';
const CONTACT = '53088888-8888-7888-8888-888888888901';

const REQUEST_ID = 'tar530-int-spec';

/** The seeded value every case must still find afterwards. */
const SEEDED = { tier: 'gold' } as const;

/** Definitions the writes below are validated against. `tier` carries the seeded value. */
const FIELD_KEYS = ['tier', 'plan', 'region', 'owner', 'segment', 'source'] as const;

/** Long enough for the waiter to register as blocked on us, short enough to fail fast. */
const BLOCK_WAIT_MS = 5_000;
const BLOCK_POLL_MS = 25;

/** Room for the writer under test to sit blocked while the fixture holds the row. */
const HOLD_TIMEOUT_MS = 20_000;

describe('concurrent custom-field writes to one contact', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let contacts: ContactsService;

  /** The service as its controller drives it: a tenant in scope, no principal. */
  function patchCustomFields(customFields: CustomFieldValues): Promise<ContactResponse> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: TENANT, userId: null, principal: null },
      () => contacts.update(CONTACT, { customFields }),
    );
  }

  async function storedCustomFields(): Promise<unknown> {
    const row = await systemPrisma.contact.findUniqueOrThrow({
      where: { id: CONTACT },
      select: { customFields: true },
    });

    return row.customFields;
  }

  /**
   * Resolves once somebody is waiting on **this transaction specifically**.
   *
   * A row-lock waiter blocks on a `ShareLock` on the holder's transaction id, so
   * "is anyone queued behind me" is exactly `pg_locks` filtered to an ungranted
   * `transactionid` lock naming our own xid. `pg_current_xact_id()` is the xid to
   * compare against — the holder has a real one because it has already written.
   *
   * Two cheaper questions are both wrong here, quietly:
   *
   *   * `pg_locks WHERE NOT granted` alone counts ungranted locks across the
   *     whole cluster, so any unrelated waiter — a dev API on the same Postgres,
   *     a second CI job on a shared container — opens the gate before the writer
   *     under test has even opened its transaction. The fixture then commits, the
   *     writer runs uncontended, and the case passes with the lock removed: a
   *     green regression test that no longer tests the regression.
   *   * `pg_blocking_pids` over `pg_stat_activity` reads as the obvious phrasing,
   *     but this fixture connects as `whatsappcrm_system` and the writer as
   *     `whatsappcrm_app`, and a non-superuser that is not in `pg_read_all_stats`
   *     does not get the other role's row — the view returns this backend alone,
   *     so the gate never fires. `pg_locks` carries no such masking.
   *
   * Polled rather than slept on. A fixed sleep would either be flaky on a loaded
   * machine or slow on an idle one, and it would silently stop gating the moment
   * the writer got faster than the sleep.
   */
  async function waitUntilBlockedOnUs(holder: Prisma.TransactionClient): Promise<void> {
    const deadline = Date.now() + BLOCK_WAIT_MS;

    while (Date.now() < deadline) {
      const [blocked] = await holder.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting
        FROM pg_locks
        WHERE NOT granted
          AND locktype = 'transactionid'
          AND transactionid = pg_current_xact_id()::xid
      `;

      if ((blocked?.waiting ?? 0) > 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
    }

    throw new Error(
      'Nothing queued behind this transaction within ' +
        `${String(BLOCK_WAIT_MS)}ms — the writer under test never reached the contact row.`,
    );
  }

  /**
   * Holds the contact row with `competingWrite`, starts `writer` against it, and
   * commits only once that writer is provably blocked on the holding
   * transaction. That ordering is what makes these cases deterministic instead of
   * racy — see the file header.
   */
  async function whileHoldingContact(
    competingWrite: (tx: Prisma.TransactionClient) => Promise<unknown>,
    writer: () => Promise<ContactResponse>,
  ): Promise<void> {
    let inFlight: Promise<ContactResponse> | undefined;

    try {
      await systemPrisma.$transaction(
        async (tx) => {
          await competingWrite(tx);

          // Started, deliberately not awaited: it has to be in flight and
          // blocked on this transaction's row lock before that transaction
          // commits.
          inFlight = writer();

          await waitUntilBlockedOnUs(tx);
        },
        { timeout: HOLD_TIMEOUT_MS },
      );
    } finally {
      // Absorbed here so that when the gate above throws, the writer's own
      // rejection cannot surface as an unhandled rejection and bury the
      // diagnostic. A real writer failure is still reported — the `await` below
      // re-raises it on the path where the gate succeeded.
      await inFlight?.catch(() => undefined);
    }

    await inFlight;
  }

  async function removeFixture(): Promise<void> {
    // The contact and its field definitions both cascade from the tenant.
    await systemPrisma.tenant.deleteMany({ where: { id: TENANT } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    contacts = new ContactsService(withTenantScope(tenantBase, tenantContext), tenantContext);

    await removeFixture();
    await systemPrisma.tenant.create({
      data: {
        id: TENANT,
        slug: 'tar530-fixture',
        name: 'TAR-530 fixture',
        // Every statement below runs through `assert_tenant_active`, which
        // admits only this status.
        status: 'active',
        customFieldDefs: {
          create: FIELD_KEYS.map((key, position) => ({ key, label: key, position })),
        },
      },
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.contact.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.contact.create({
      data: {
        id: CONTACT,
        tenantId: TENANT,
        phoneE164: '+10000053001',
        displayName: 'Layla',
        customFields: SEEDED,
      },
      select: { id: true },
    });
  });

  /**
   * The failure TAR-530 was filed for, reproduced deterministically.
   *
   * The competing transaction writes `plan` and keeps the row locked until the
   * `region` write is provably waiting. Without `lockContact` the `region` write
   * read `{tier}` before blocking and writes `{tier, region}` — `plan` is gone.
   * With it, it blocks before reading anything and merges into `{tier, plan}`.
   */
  it('does not lose a write committed while another write was in flight', async () => {
    await whileHoldingContact(
      (tx) => tx.$executeRaw`
        UPDATE contacts
           SET custom_fields = custom_fields || '{"plan":"pro"}'::jsonb,
               updated_at = now()
         WHERE id = ${CONTACT}::uuid
      `,
      () => patchCustomFields({ region: 'emea' }),
    );

    expect(await storedCustomFields()).toEqual({ tier: 'gold', plan: 'pro', region: 'emea' });
  });

  /**
   * The same shape as the report — several agents patching different keys at
   * once — rather than one competing writer. Racy on its own, and included
   * because the lock is what makes its outcome *not* depend on the interleaving:
   * every writer waits its turn and merges into what the previous one committed.
   */
  it('keeps every key when several agents patch different fields at once', async () => {
    const writers = ['plan', 'region', 'owner', 'segment', 'source'] as const;

    await Promise.all(writers.map((key) => patchCustomFields({ [key]: `${key}-value` })));

    expect(await storedCustomFields()).toEqual({
      ...SEEDED,
      ...Object.fromEntries(writers.map((key) => [key, `${key}-value`])),
    });
  });

  /**
   * Clearing is the other half of the merge, and it races the same way: an
   * explicit `null` deletes its key, and must not carry a stale copy of a
   * neighbouring key back with it.
   */
  it('does not resurrect a key that a concurrent write cleared', async () => {
    await patchCustomFields({ plan: 'pro' });

    await whileHoldingContact(
      (tx) => tx.$executeRaw`
        UPDATE contacts
           SET custom_fields = custom_fields || '{"region":"emea"}'::jsonb,
               updated_at = now()
         WHERE id = ${CONTACT}::uuid
      `,
      () => patchCustomFields({ plan: null }),
    );

    expect(await storedCustomFields()).toEqual({ tier: 'gold', region: 'emea' });
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run the suite through \`pnpm test:db\` with the stack up: ` +
        'pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login',
    );
  }

  return value;
}
