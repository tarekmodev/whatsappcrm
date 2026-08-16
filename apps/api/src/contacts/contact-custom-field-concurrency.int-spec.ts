import type { ContactResponse, CustomFieldValues } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
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
 * takes no lock, so without the `FOR UPDATE` in `lockContact` both writers read
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
 * its lock (`pg_locks`, no row granted), and only then committed. Without the
 * fix that writer has already taken its stale read by the time it blocks, and
 * the assertion fails every run.
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

/** Long enough for a blocked backend to appear in `pg_locks`, short enough to fail fast. */
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
   * Resolves once some backend is waiting on a lock it has not been granted.
   *
   * `pg_locks` rather than `pg_stat_activity`: it is readable in full by any
   * role, while a non-superuser sees another role's activity row with its
   * columns masked — and the writer under test connects as `whatsappcrm_app`
   * while this fixture connects as `whatsappcrm_system`.
   *
   * Polled rather than slept on. A fixed sleep would either be flaky on a loaded
   * machine or slow on an idle one, and it would silently stop gating the moment
   * the writer got faster than the sleep.
   */
  async function waitUntilBlocked(): Promise<void> {
    const deadline = Date.now() + BLOCK_WAIT_MS;

    while (Date.now() < deadline) {
      const [blocked] = await systemPrisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted
      `;

      if ((blocked?.waiting ?? 0) > 0) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, BLOCK_POLL_MS));
    }

    throw new Error(
      'No backend blocked on a lock within ' +
        `${String(BLOCK_WAIT_MS)}ms — the writer under test never reached the contact row.`,
    );
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
    let region: Promise<ContactResponse> | undefined;

    await systemPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE contacts
             SET custom_fields = custom_fields || '{"plan":"pro"}'::jsonb,
                 updated_at = now()
           WHERE id = ${CONTACT}::uuid
        `;

        // Started, deliberately not awaited: it has to be in flight and blocked
        // on this transaction's row lock before that transaction commits.
        region = patchCustomFields({ region: 'emea' });

        await waitUntilBlocked();
      },
      { timeout: HOLD_TIMEOUT_MS },
    );

    await region;

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

    let cleared: Promise<ContactResponse> | undefined;

    await systemPrisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`
          UPDATE contacts
             SET custom_fields = custom_fields || '{"region":"emea"}'::jsonb,
                 updated_at = now()
           WHERE id = ${CONTACT}::uuid
        `;

        cleared = patchCustomFields({ plan: null });

        await waitUntilBlocked();
      },
      { timeout: HOLD_TIMEOUT_MS },
    );

    await cleared;

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
