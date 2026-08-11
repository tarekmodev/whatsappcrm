import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-74: the one-active-ticket-per-contact invariant, against a real
 * PostgreSQL as `whatsappcrm_app`.
 *
 * `verify-tenant-isolation.sql` proves `tickets` and `ticket_counters` are
 * tenant-isolated. This file proves the other half — the property TAR-21
 * actually depends on, which RLS says nothing about: **two inbound messages
 * from the same contact, processed concurrently, produce one ticket.**
 *
 * It has to be an integration test and it has to run two connections. The race
 * is between two uncommitted transactions, so there is no single-session SQL
 * script and no unit test that can observe it — a mocked Prisma client would
 * assert the code we wrote, not the guarantee the database gives.
 *
 * It is also the only thing that notices if the index goes missing.
 * `tickets_one_active_per_contact` is partial, Prisma's schema language cannot
 * express it, and Prisma's describer skips it — so `migrate dev` will neither
 * recreate nor complain about it. A database built from `schema.prisma` alone
 * loses the invariant silently, and silent is exactly what 0003 names as this
 * component's failure mode ("if it is missing, duplicates appear silently").
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar74-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '74777777-7777-7777-8777-777777777701';
const TENANT_B = '74777777-7777-7777-8777-777777777702';

const WABA_A = '74777777-7777-7777-8777-7777777777a0';
const ACCOUNT_A = '74777777-7777-7777-8777-7777777777a1';
/** The contact every concurrency case is about. */
const CONTACT_A = '74777777-7777-7777-8777-7777777777a2';
/** A second contact in the same tenant — the case that must NOT conflict. */
const CONTACT_A2 = '74777777-7777-7777-8777-7777777777a3';
const CONVERSATION_A = '74777777-7777-7777-8777-7777777777a4';
const CONVERSATION_A2 = '74777777-7777-7777-8777-7777777777a5';

const WABA_B = '74777777-7777-7777-8777-7777777777b0';
const ACCOUNT_B = '74777777-7777-7777-8777-7777777777b1';
const CONTACT_B = '74777777-7777-7777-8777-7777777777b2';
const CONVERSATION_B = '74777777-7777-7777-8777-7777777777b3';

const REQUEST_ID = 'tar74-int-spec';

interface AllocatedTicket {
  id: string;
  number: number;
}

/**
 * Asserts a single row and hands it back. `noUncheckedIndexedAccess` is on, so
 * `rows[0]` is `T | undefined` everywhere; this keeps the assertion where the
 * meaning is ("the create path won") instead of scattering non-null assertions.
 */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('one active ticket per contact', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  /**
   * TAR-73 decision 2's create path, verbatim — one statement that allocates a
   * number and inserts the ticket, and cannot produce a duplicate.
   *
   * Written here as raw SQL rather than through the Prisma client on purpose.
   * The client has no way to express either half: `ON CONFLICT … WHERE` against
   * a partial index, or a data-modifying CTE. This is the statement TAR-75 will
   * ship, so this is the statement that has to be proven to work.
   *
   * Zero rows back means another transaction won the race — not an error.
   */
  function createTicket(
    tenantId: string,
    conversationId: string,
    contactId: string | null,
    ticketId: string,
  ): Promise<AllocatedTicket[]> {
    return asTenant(
      tenantId,
      () =>
        tenantPrisma.$queryRaw<AllocatedTicket[]>`
        WITH allocated AS (
          INSERT INTO ticket_counters (tenant_id, next_number) VALUES (${tenantId}::uuid, 2)
          ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
          RETURNING next_number - 1 AS number
        )
        INSERT INTO tickets (id, tenant_id, number, status, conversation_id, contact_id, created_at, updated_at)
        SELECT ${ticketId}::uuid, ${tenantId}::uuid, allocated.number, 'open',
               ${conversationId}::uuid, ${contactId}::uuid, now(), now()
        FROM allocated
        ON CONFLICT (tenant_id, contact_id) WHERE status IN ('open', 'pending') DO NOTHING
        RETURNING id, number
      `,
    );
  }

  function activeTicketsFor(contactId: string): Promise<{ id: string }[]> {
    return systemPrisma.ticket.findMany({
      where: { contactId, status: { in: ['open', 'pending'] } },
      select: { id: true },
    });
  }

  async function removeFixture(): Promise<void> {
    // tickets, ticket_counters and the conversation tables all cascade from the
    // tenant, so one delete is enough and stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar74-fixture-a', name: 'TAR-74 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar74-fixture-b', name: 'TAR-74 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar74-fixture-a-waba' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar74-fixture-b-waba' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar74-fixture-a-phone',
          displayPhoneNumber: '+10000000741',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar74-fixture-b-phone',
          displayPhoneNumber: '+10000000742',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+10000007401' },
        { id: CONTACT_A2, tenantId: TENANT_A, phoneE164: '+10000007402' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000007403' },
      ],
    });
    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A,
        },
        {
          id: CONVERSATION_A2,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A2,
        },
        {
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: ACCOUNT_B,
          contactId: CONTACT_B,
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Each case starts from "this contact has no ticket". The counter is left
    // alone deliberately — numbers carry over between cases exactly as they
    // would between requests, and nothing here depends on their value.
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
  });

  describe('the index itself', () => {
    it('exists, is unique, and covers pending as well as open', async () => {
      // `schema.prisma` cannot express a partial index and Prisma's describer
      // skips it, so nothing else in the toolchain would notice its absence.
      // Asserting the definition rather than just the name: a predicate quietly
      // narrowed back to `status = 'open'` is the specific regression TAR-73
      // amended this story to prevent, and it would pass a name-only check.
      const index = only(
        await systemPrisma.$queryRaw<{ indexdef: string }[]>`
          SELECT indexdef FROM pg_indexes
          WHERE schemaname = 'public' AND indexname = 'tickets_one_active_per_contact'
        `,
      );

      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      // Leading with tenant_id is what makes a conflict impossible to cause
      // across tenants (0003, security and access).
      expect(index.indexdef).toContain('(tenant_id, contact_id)');
      expect(index.indexdef).toMatch(/WHERE \(status = ANY \(.*'open'.*'pending'.*\)\)/s);
    });
  });

  describe('concurrent creation for one contact', () => {
    it('produces exactly one ticket, and the loser conflicts cleanly', async () => {
      const [first, second] = await Promise.all([
        createTicket(TENANT_A, CONVERSATION_A, CONTACT_A, '74777777-7777-7777-8777-777777770001'),
        createTicket(TENANT_A, CONVERSATION_A, CONTACT_A, '74777777-7777-7777-8777-777777770002'),
      ]);

      // One winner, one empty result — not one winner and one thrown error.
      // `ON CONFLICT DO NOTHING` is what lets the losing job re-read and attach
      // instead of burning a retry (0003, decision 2).
      const winners = [first, second].filter((rows) => rows.length === 1);
      const losers = [first, second].filter((rows) => rows.length === 0);

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);

      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });

    it('burns a number on the loser, which is expected and harmless', async () => {
      // Relative, not absolute: `beforeEach` clears tickets but deliberately
      // leaves the counter alone, so its value carries over between cases the
      // same way it carries over between requests.
      const before = await systemPrisma.ticketCounter.findUnique({ where: { tenantId: TENANT_A } });

      await Promise.all([
        createTicket(TENANT_A, CONVERSATION_A, CONTACT_A, '74777777-7777-7777-8777-777777770003'),
        createTicket(TENANT_A, CONVERSATION_A, CONTACT_A, '74777777-7777-7777-8777-777777770004'),
      ]);

      // Both transactions allocated; only one inserted. Ticket numbers are
      // unique and monotonic, never gapless — asserted so that a future change
      // making them gapless is a deliberate decision rather than an accident.
      const after = await systemPrisma.ticketCounter.findUnique({ where: { tenantId: TENANT_A } });
      const tickets = await systemPrisma.ticket.findMany({ where: { tenantId: TENANT_A } });

      expect(tickets).toHaveLength(1);
      expect((after?.nextNumber ?? 0) - (before?.nextNumber ?? 1)).toBe(2);
    });
  });

  describe('concurrency, with the winner still uncommitted', () => {
    it('makes the second insert wait rather than slip past into a duplicate', async () => {
      // The case `Promise.all` above cannot distinguish: if the first
      // transaction happens to commit before the second begins, the second
      // conflicts with a *committed* row and the result looks identical. The
      // dangerous version is two transactions genuinely overlapping, and the
      // only way to observe it is to hold one open.
      //
      // This is also the convoy 0003 names as the known cost (decision 2): the
      // contender blocks on the counter row lock for the duration of the
      // winner's transaction. Asserting it stays pending is asserting the
      // mechanism, not just its outcome.
      let contender: Promise<AllocatedTicket[]> | undefined;

      const winner = await asTenant(TENANT_A, () =>
        tenantPrisma.$tenantTransaction(async (tx) => {
          const rows = await tx.$queryRaw<AllocatedTicket[]>`
            WITH allocated AS (
              INSERT INTO ticket_counters (tenant_id, next_number) VALUES (${TENANT_A}::uuid, 2)
              ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
              RETURNING next_number - 1 AS number
            )
            INSERT INTO tickets (id, tenant_id, number, status, conversation_id, contact_id, created_at, updated_at)
            SELECT ${'74777777-7777-7777-8777-777777770020'}::uuid, ${TENANT_A}::uuid,
                   allocated.number, 'open', ${CONVERSATION_A}::uuid, ${CONTACT_A}::uuid, now(), now()
            FROM allocated
            ON CONFLICT (tenant_id, contact_id) WHERE status IN ('open', 'pending') DO NOTHING
            RETURNING id, number
          `;

          contender = createTicket(
            TENANT_A,
            CONVERSATION_A,
            CONTACT_A,
            '74777777-7777-7777-8777-777777770021',
          );

          // Can only fail in one direction: the contender settling here means
          // it reached the index without waiting, which is the defect.
          await expect(
            Promise.race([contender.then(() => 'settled'), sleep(250).then(() => 'blocked')]),
          ).resolves.toBe('blocked');

          return rows;
        }),
      );

      expect(winner).toHaveLength(1);
      // Released by the commit, and it finds the conflict rather than a gap.
      expect(await contender).toHaveLength(0);
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });
  });

  describe('what counts as active', () => {
    it('refuses a second ticket while the first is pending', async () => {
      // The amendment TAR-73 made to this story. `pending` means waiting on the
      // customer, so their reply belongs to the ticket that already exists —
      // indexing on `open` alone would hand them a duplicate here.
      const created = only(
        await createTicket(
          TENANT_A,
          CONVERSATION_A,
          CONTACT_A,
          '74777777-7777-7777-8777-777777770005',
        ),
      );

      await systemPrisma.ticket.update({ where: { id: created.id }, data: { status: 'pending' } });

      const second = await createTicket(
        TENANT_A,
        CONVERSATION_A,
        CONTACT_A,
        '74777777-7777-7777-8777-777777770006',
      );

      expect(second).toHaveLength(0);
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });

    it.each(['resolved', 'closed'] as const)(
      'allows a new ticket once the previous one is %s',
      async (terminal) => {
        const created = only(
          await createTicket(
            TENANT_A,
            CONVERSATION_A,
            CONTACT_A,
            '74777777-7777-7777-8777-777777770007',
          ),
        );
        await systemPrisma.ticket.update({ where: { id: created.id }, data: { status: terminal } });

        // A customer writing back after resolution gets a new ticket. There is
        // no reopen window at v1 — 0003, open question 1.
        const reopened = await createTicket(
          TENANT_A,
          CONVERSATION_A,
          CONTACT_A,
          '74777777-7777-7777-8777-777777770008',
        );

        expect(reopened).toHaveLength(1);
        expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
      },
    );

    it('rejects a status change that would create a second active ticket', async () => {
      // The index constrains UPDATE as well as INSERT, which is the part an
      // application-level check-then-insert would never cover: resolving a
      // ticket, opening a new one, then reopening the old one.
      const first = only(
        await createTicket(
          TENANT_A,
          CONVERSATION_A,
          CONTACT_A,
          '74777777-7777-7777-8777-777777770009',
        ),
      );
      await systemPrisma.ticket.update({ where: { id: first.id }, data: { status: 'resolved' } });
      await createTicket(
        TENANT_A,
        CONVERSATION_A,
        CONTACT_A,
        '74777777-7777-7777-8777-77777777000a',
      );

      await expect(
        systemPrisma.ticket.update({ where: { id: first.id }, data: { status: 'open' } }),
      ).rejects.toThrow();

      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
    });
  });

  describe('what the index must not constrain', () => {
    it('lets two contacts in one tenant each hold an active ticket', async () => {
      const first = only(
        await createTicket(
          TENANT_A,
          CONVERSATION_A,
          CONTACT_A,
          '74777777-7777-7777-8777-77777777000b',
        ),
      );
      const second = only(
        await createTicket(
          TENANT_A,
          CONVERSATION_A2,
          CONTACT_A2,
          '74777777-7777-7777-8777-77777777000c',
        ),
      );

      // Distinct numbers out of the tenant's shared counter, which is the other
      // thing the allocator has to get right under the same row lock.
      expect(first.number).not.toBe(second.number);
    });

    it('lets two tenants each hold an active ticket at the same time', async () => {
      // The cross-tenant case, and a caveat worth writing down: a *literally*
      // shared `contact_id` cannot occur, because `contacts.id` is a global
      // primary key and `tickets.contact_id` is a composite foreign key to
      // `(tenant_id, id)`. So the collision this guards against is unreachable
      // through the schema, and `tenant_id` leading the index is belt to that
      // braces. What is reachable — and asserted here — is two tenants working
      // concurrently without one blocking or conflicting with the other.
      const [inA, inB] = await Promise.all([
        createTicket(TENANT_A, CONVERSATION_A, CONTACT_A, '74777777-7777-7777-8777-77777777000d'),
        createTicket(TENANT_B, CONVERSATION_B, CONTACT_B, '74777777-7777-7777-8777-77777777000e'),
      ]);

      expect(inA).toHaveLength(1);
      expect(inB).toHaveLength(1);
      // Each tenant numbers its own tickets. Two tenants both holding #1 is
      // correct; the key is `(tenant_id, number)`.
      expect(await activeTicketsFor(CONTACT_A)).toHaveLength(1);
      expect(await activeTicketsFor(CONTACT_B)).toHaveLength(1);
    });

    it('lets a tenant hold several active tickets with no contact', async () => {
      // TAR-25's manual ticket. Postgres does not collide NULLs in a unique
      // index, which is why `contact_id` stays nullable — making it NOT NULL to
      // tidy the column would break this.
      const first = await createTicket(
        TENANT_A,
        CONVERSATION_A,
        null,
        '74777777-7777-7777-8777-77777777000f',
      );
      const second = await createTicket(
        TENANT_A,
        CONVERSATION_A,
        null,
        '74777777-7777-7777-8777-777777770010',
      );

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(1);
    });
  });

  describe('the ticket-number allocator', () => {
    it('creates its row on the first ticket and hands out 1', async () => {
      await systemPrisma.ticketCounter.deleteMany({ where: { tenantId: TENANT_B } });

      const created = only(
        await createTicket(
          TENANT_B,
          CONVERSATION_B,
          CONTACT_B,
          '74777777-7777-7777-8777-777777770011',
        ),
      );

      // Self-provisioning: no change to TAR-50's tenant provisioning flow.
      expect(created.number).toBe(1);
      const counter = await systemPrisma.ticketCounter.findUnique({
        where: { tenantId: TENANT_B },
      });
      expect(counter?.nextNumber).toBe(2);
      // The raw upsert names only (tenant_id, next_number); `updated_at` is
      // NOT NULL and has to come from the column default or ticket creation is
      // impossible.
      expect(counter?.updatedAt).toBeInstanceOf(Date);
    });

    it('refuses a duplicate ticket number within a tenant', async () => {
      // The backstop under the allocator: if it ever hands out a number twice,
      // the write fails rather than producing two tickets that look like one.
      const created = only(
        await createTicket(
          TENANT_A,
          CONVERSATION_A,
          CONTACT_A,
          '74777777-7777-7777-8777-777777770012',
        ),
      );

      await expect(
        systemPrisma.ticket.create({
          data: {
            id: '74777777-7777-7777-8777-777777770013',
            tenantId: TENANT_A,
            number: created.number,
            conversationId: CONVERSATION_A2,
            contactId: CONTACT_A2,
          },
        }),
      ).rejects.toThrow();
    });
  });

  describe('through the app role, under RLS', () => {
    it('cannot see or touch another tenant’s counter', async () => {
      await createTicket(
        TENANT_B,
        CONVERSATION_B,
        CONTACT_B,
        '74777777-7777-7777-8777-777777770014',
      );

      const seen = await asTenant(TENANT_A, () =>
        tenantPrisma.ticketCounter.findMany({ select: { tenantId: true } }),
      );

      expect(seen.every((row) => row.tenantId === TENANT_A)).toBe(true);

      const bumped = await asTenant(TENANT_A, () =>
        tenantPrisma.ticketCounter.updateMany({
          where: { tenantId: TENANT_B },
          data: { nextNumber: 999_999 },
        }),
      );

      expect(bumped.count).toBe(0);
    });
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
