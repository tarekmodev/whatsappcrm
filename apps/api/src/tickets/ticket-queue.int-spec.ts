import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  permissionsForRole,
  type Permission,
  type SessionPrincipal,
  type TicketLinkResult,
  type TicketResponse,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { TicketCommandService } from './ticket-command.service';
import { TicketLinkerService } from './ticket-linker.service';
import { TicketQueryService } from './ticket-query.service';
import {
  InvalidTicketCursorError,
  TicketCloseNotPermittedError,
  TicketNotFoundError,
  TicketStatusChangedConcurrentlyError,
  TicketTransitionNotAllowedError,
} from './tickets.errors';

/**
 * TAR-25's three acceptance criteria against a real PostgreSQL with TAR-48's
 * policies applied, running as `whatsappcrm_app` — the role holding no
 * `BYPASSRLS`.
 *
 * A unit test can show that the writer checks a column. Only this can show that
 * the behaviour is real:
 *
 *   * a resolved ticket **leaves the active queue** and carries `resolved_at`,
 *     because the queue's default is a `WHERE` and not a client convention;
 *   * a `pending` ticket **reopens on the customer's reply**, through the
 *     shipped `TicketLinkerService` and its `status_changed` /
 *     `inbound_message` event — TAR-284 wires nothing new for this and this
 *     spec is what proves it still works beside the new write;
 *   * `urgent` sorts to the top, which is true only because `ticket_priority`
 *     is declared `low, normal, high, urgent` and Postgres orders an enum by
 *     declaration order. Nothing in TypeScript can catch a reorder; this can;
 *   * the **reopen race in both orderings** — the agent winning produces a
 *     *second* ticket for the contact, and the reopen winning produces a
 *     `conflict` for the agent;
 *   * tenant A cannot read or change tenant B's ticket, an agent without
 *     `ticket:read_all` cannot reach a colleague's, and a principal without
 *     `ticket:close` cannot resolve one.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar284-fixture` marker, deleted before the run
 * as well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '25444444-4444-7444-8444-444444444401';
const TENANT_B = '25444444-4444-7444-8444-444444444402';

const WABA_A = '25444444-4444-7444-8444-4444444444b1';
const NUMBER_A = '25444444-4444-7444-8444-4444444444a1';
const WABA_B = '25444444-4444-7444-8444-4444444444b9';
const NUMBER_B = '25444444-4444-7444-8444-4444444444a9';

const SUPERVISOR_A = '25444444-4444-7444-8444-4444444444d0';
const AGENT_A = '25444444-4444-7444-8444-4444444444d1';
const OTHER_AGENT_A = '25444444-4444-7444-8444-4444444444d2';
const AGENT_B = '25444444-4444-7444-8444-4444444444d9';

/** One contact per active ticket: `tickets_one_active_per_contact` allows no more. */
const CONTACTS = [
  '25444444-4444-7444-8444-4444444444c1',
  '25444444-4444-7444-8444-4444444444c2',
  '25444444-4444-7444-8444-4444444444c3',
  '25444444-4444-7444-8444-4444444444c4',
  '25444444-4444-7444-8444-4444444444c5',
  '25444444-4444-7444-8444-4444444444c6',
  '25444444-4444-7444-8444-4444444444c7',
  '25444444-4444-7444-8444-4444444444c8',
  '25444444-4444-7444-8444-4444444444c9',
  '25444444-4444-7444-8444-4444444444ca',
  '25444444-4444-7444-8444-4444444444cc',
] as const;
const CONTACT_B = '25444444-4444-7444-8444-4444444444cb';

const URGENT = '25444444-4444-7444-8444-4444444444f1';
const HIGH = '25444444-4444-7444-8444-4444444444f2';
const NORMAL_NEW = '25444444-4444-7444-8444-4444444444f3';
const NORMAL_OLD = '25444444-4444-7444-8444-4444444444f4';
const PENDING = '25444444-4444-7444-8444-4444444444f5';
const REOPEN_WINS = '25444444-4444-7444-8444-4444444444f6';
const AGENT_WINS = '25444444-4444-7444-8444-4444444444f7';
const COLLEAGUES = '25444444-4444-7444-8444-4444444444f8';
const UNASSIGNED = '25444444-4444-7444-8444-4444444444f9';
/** The linker reads this one as `pending` and loses its reopen to the agent. */
const REOPEN_LOSES = '25444444-4444-7444-8444-4444444444fc';
const LOW = '25444444-4444-7444-8444-4444444444fa';
const TENANT_B_TICKET = '25444444-4444-7444-8444-4444444444fb';

/**
 * The queue as the fixture defines it: `priority DESC, createdAt DESC, id DESC`
 * over the eleven active tickets of tenant A, before any test has changed one.
 *
 * Written out rather than derived, so a change to the sort has to be a change to
 * this list — a computed expectation would re-derive the bug.
 */
const QUEUE_IN_ORDER = [
  URGENT,
  HIGH,
  NORMAL_NEW,
  NORMAL_OLD,
  PENDING,
  REOPEN_WINS,
  AGENT_WINS,
  COLLEAGUES,
  UNASSIGNED,
  REOPEN_LOSES,
  LOW,
] as const;

const REQUEST_ID = 'tar284-int-spec';
const FIXTURE_PREFIX = 'tar284-fixture';

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Above every `number` the fixture hands out, so the linker's allocator cannot
 * collide with a seeded ticket on `UNIQUE (tenant_id, number)`. The counter is
 * created lazily by the first real ticket and holds the *next* number, so a
 * fixture that inserts rows behind its back has to move it forward itself.
 */
const NEXT_TICKET_NUMBER = 50;

function principalFor(
  tenantId: string,
  userId: string,
  role: 'agent' | 'supervisor',
  permissions: readonly Permission[] = permissionsForRole(role),
): SessionPrincipal {
  return {
    userId,
    tenantId,
    email: `${userId}@example.invalid`,
    displayName: 'Fixture user',
    role,
    permissions: [...permissions],
    teamIds: [],
    sessionId: userId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

describe('ticket status, priority and the active queue, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let tickets: TicketQueryService;
  let commands: TicketCommandService;
  let linker: TicketLinkerService;

  function as<T>(principal: SessionPrincipal, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      {
        requestId: REQUEST_ID,
        tenantId: principal.tenantId,
        userId: principal.userId,
        principal,
      },
      async () => await work(),
    );
  }

  /** The supervisor's tenant-wide view — `ticket:read_all`, so `scope=all` is honoured. */
  function queue(
    principal: SessionPrincipal,
    query: Partial<Parameters<TicketQueryService['list']>[0]> = {},
  ): Promise<{ items: TicketResponse[]; nextCursor: string | null }> {
    return as(principal, async () =>
      tickets.list({ limit: 25, scope: 'all', breachedOnly: false, ...query }),
    );
  }

  /**
   * The customer replying: an inbound message on the contact's conversation,
   * then the queue job TAR-20's writer would enqueue once it committed.
   *
   * The real pipeline is `TicketQueueRunner` consuming
   * `ticket.ensure-for-message`; calling the linker directly is the same code
   * with the transport left out, which is what makes the interleaving below
   * deterministic instead of a sleep.
   */
  async function customerReplies(
    index: number,
    using: TicketLinkerService = linker,
  ): Promise<TicketLinkResult> {
    const messageId = await as(
      principalFor(TENANT_A, AGENT_A, 'agent'),
      async () =>
        (
          await tenantPrisma.message.create({
            data: {
              tenantId: TENANT_A,
              conversationId: conversationFor(index),
              direction: 'inbound',
              status: 'delivered',
              body: 'Any news?',
              sentAt: new Date(),
            },
            select: { id: true },
          })
        ).id,
    );

    // No principal: a queue worker has a tenant and nobody to attribute to,
    // which is exactly what makes the reopen's `actorUserId` null.
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId: TENANT_A, userId: null, principal: null },
      async () =>
        await using.ensureTicketForMessage({
          tenantId: TENANT_A,
          contactId: CONTACTS[index] ?? '',
          conversationId: conversationFor(index),
          messageId,
          receivedAt: new Date().toISOString(),
        }),
    );
  }

  /**
   * A linker whose transaction runs `interrupt` the first time it reads the
   * contact's active ticket — after the read, before the compare-and-set.
   *
   * That window is the whole of the defect this guards: the linker sees
   * `pending`, an agent's `PATCH` commits, and the reopen's
   * `WHERE status = 'pending'` then matches nothing. Reproducing it by racing two
   * promises would be a coin flip; wrapping the one statement whose ordering
   * matters makes it a fact.
   *
   * `interrupt` runs in its own transaction, and READ COMMITTED is what makes
   * that legal here: the linker holds no lock on the row (its read is a plain
   * `SELECT`), and its later `UPDATE` re-reads the newest committed version.
   *
   * The client is assembled by hand rather than proxied because the linker uses
   * exactly these four operations inside its transaction — a narrower stub than
   * a proxy, and one that fails to compile if that ever stops being true.
   */
  function linkerInterruptedAfterRead(interrupt: () => Promise<unknown>): TicketLinkerService {
    let interrupted = false;

    const racingPrisma = {
      message: tenantPrisma.message,
      $tenantTransaction: <T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
        tenantPrisma.$tenantTransaction(async (tx) => {
          const spy = {
            ticket: {
              findFirst: async (args: Parameters<typeof tx.ticket.findFirst>[0]) => {
                const row = await tx.ticket.findFirst(args);

                if (!interrupted) {
                  interrupted = true;
                  await interrupt();
                }

                return row;
              },
              updateMany: tx.ticket.updateMany.bind(tx.ticket),
            },
            ticketEvent: { create: tx.ticketEvent.create.bind(tx.ticketEvent) },
            $queryRaw: tx.$queryRaw.bind(tx),
          };

          return work(spy as unknown as Prisma.TransactionClient);
        }),
    } as unknown as TenantPrisma;

    return new TicketLinkerService(racingPrisma, tenantContext, new EventEmitter2());
  }

  /** Every event on a ticket, oldest first, as the log holds them. */
  function eventsOn(
    ticketId: string,
  ): Promise<{ type: string; actorUserId: string | null; data: unknown }[]> {
    return as(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), async () =>
      tenantPrisma.ticketEvent.findMany({
        where: { ticketId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { type: true, actorUserId: true, data: true },
      }),
    );
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    tickets = new TicketQueryService(tenantPrisma, tenantContext);
    commands = new TicketCommandService(tenantPrisma, tickets, tenantContext, new EventEmitter2());
    linker = new TicketLinkerService(tenantPrisma, tenantContext, new EventEmitter2());

    await removeFixture();
    await seedFixture(systemPrisma);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  // -------------------------------------------------------------------------
  // These blocks run in declaration order and the later ones mutate rows the
  // earlier ones read. The queue's shape is therefore asserted first, against
  // the fixture as seeded.
  // -------------------------------------------------------------------------

  describe('the active queue', () => {
    it('returns the tenant’s active tickets urgent-first, newest-first within a band', async () => {
      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).toEqual([...QUEUE_IN_ORDER]);
      expect(page.nextCursor).toBeNull();
    });

    it('puts urgent above low, which is the declaration order of the enum', async () => {
      // The assertion 0006 §6 asks for by name: `priority DESC` is urgent-first
      // only because `ticket_priority` is declared `low, normal, high, urgent`.
      // Reordering those labels inverts the queue with no error anywhere.
      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));
      const priorities = page.items.map((ticket) => ticket.priority);

      expect(priorities[0]).toBe('urgent');
      expect(priorities.at(-1)).toBe('low');
    });

    it('excludes resolved and closed tickets without being asked to', async () => {
      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(
        page.items.every((ticket) => ticket.status === 'open' || ticket.status === 'pending'),
      ).toBe(true);
    });

    it('pages by keyset without skipping or repeating a row', async () => {
      const supervisor = principalFor(TENANT_A, SUPERVISOR_A, 'supervisor');
      const walked: string[] = [];
      let cursor: string | undefined;

      do {
        const page = await queue(supervisor, { limit: 3, cursor });

        walked.push(...page.items.map((ticket) => ticket.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      expect(walked).toEqual([...QUEUE_IN_ORDER]);
    });

    it('refuses a cursor from a list with a different sort key', async () => {
      // Decodes cleanly and carries one sort value where this list needs two.
      // Paging from it would compare a timestamp against an enum column, so it
      // is `validation_failed` rather than a silent first page.
      const foreign = Buffer.from(
        JSON.stringify({ v: 1, k: ['2026-08-11T09:00:00.000Z'], id: URGENT }),
        'utf8',
      ).toString('base64url');

      await expect(
        queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), { cursor: foreign }),
      ).rejects.toBeInstanceOf(InvalidTicketCursorError);
    });

    it('refuses a cursor whose leading value is not a priority', async () => {
      const corrupt = Buffer.from(
        JSON.stringify({ v: 1, k: ['critical', '2026-08-11T09:00:00.000Z'], id: URGENT }),
        'utf8',
      ).toString('base64url');

      await expect(
        queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), { cursor: corrupt }),
      ).rejects.toBeInstanceOf(InvalidTicketCursorError);
    });
  });

  describe('resolving a ticket', () => {
    it('records resolvedAt and takes it out of the active queue', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      const resolved = await as(agent, async () => commands.update(LOW, { status: 'resolved' }));

      expect(resolved).toMatchObject({ id: LOW, status: 'resolved', closedAt: null });
      expect(resolved.resolvedAt).not.toBeNull();

      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).not.toContain(LOW);
    });

    it('is still reachable by asking for it explicitly', async () => {
      // The active-only default is what makes "it leaves the queue" true with no
      // client change; it is not a way of hiding the row.
      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        status: 'resolved',
      });

      expect(page.items.map((ticket) => ticket.id)).toEqual([LOW]);
    });

    it('appends exactly one status_changed carrying the agent and the cause', async () => {
      expect(await eventsOn(LOW)).toEqual([
        {
          type: 'status_changed',
          actorUserId: AGENT_A,
          data: { from: 'open', to: 'resolved', cause: 'agent' },
        },
      ]);
    });

    it('refuses to re-activate it, and writes nothing when it does', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      await expect(
        as(agent, async () => commands.update(LOW, { status: 'open' })),
      ).rejects.toBeInstanceOf(TicketTransitionNotAllowedError);

      expect(await eventsOn(LOW)).toHaveLength(1);
    });

    it('keeps the original resolution time when it is later closed', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');
      const before = await as(agent, async () => tickets.get(LOW));

      const closed = await as(agent, async () => commands.update(LOW, { status: 'closed' }));

      expect(closed.resolvedAt).toBe(before.resolvedAt);
      expect(closed.closedAt).not.toBeNull();
    });
  });

  describe('a priority change', () => {
    it('re-sorts the queue and appends priority_changed', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      await as(agent, async () => commands.update(NORMAL_OLD, { priority: 'urgent' }));

      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'));

      // Two urgent tickets now, and the newer of the two leads the band —
      // `NORMAL_OLD` was created three hours ago against `URGENT`'s five.
      expect(page.items.slice(0, 2).map((ticket) => ticket.id)).toEqual([NORMAL_OLD, URGENT]);
      expect(await eventsOn(NORMAL_OLD)).toEqual([
        {
          type: 'priority_changed',
          actorUserId: AGENT_A,
          data: { from: 'normal', to: 'urgent', cause: 'agent' },
        },
      ]);
    });

    it('writes nothing when the priority is already what was asked for', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      const response = await as(agent, async () =>
        commands.update(NORMAL_OLD, { priority: 'urgent' }),
      );

      expect(response.priority).toBe('urgent');
      expect(await eventsOn(NORMAL_OLD)).toHaveLength(1);
    });
  });

  describe('the customer replying to a pending ticket', () => {
    it('reopens it with no agent action', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      await as(agent, async () => commands.update(PENDING, { status: 'pending' }));
      expect(await as(agent, async () => tickets.get(PENDING))).toMatchObject({
        status: 'pending',
      });

      await customerReplies(4);

      expect(await as(agent, async () => tickets.get(PENDING))).toMatchObject({ status: 'open' });
    });

    it('records it as a status_changed by the system, not a reopened event', async () => {
      // 0006 §5, overriding TAR-284 AC4: `reopened` is reserved for the
      // resolved-reopen window of 0003, which does not exist at v1. The
      // distinction the product needs is the cause, and it is cheaper.
      expect(await eventsOn(PENDING)).toEqual([
        {
          type: 'status_changed',
          actorUserId: AGENT_A,
          data: { from: 'open', to: 'pending', cause: 'agent' },
        },
        {
          type: 'status_changed',
          actorUserId: null,
          data: { from: 'pending', to: 'open', cause: 'inbound_message' },
        },
      ]);
    });

    it('does not open a second ticket for the contact', async () => {
      const held = await as(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), async () =>
        tenantPrisma.ticket.count({ where: { contactId: CONTACTS[4] } }),
      );

      expect(held).toBe(1);
    });
  });

  describe('the reopen race', () => {
    it('answers conflict when the reopen commits first', async () => {
      // The interleaving 0006 §4 names: the agent read `pending`, the customer's
      // reply reopened the ticket, and the compare-and-set then matches nothing.
      // Reproduced by reopening inside the read rather than by racing two
      // promises and hoping.
      const racing = {
        require: async (ticketId: string) => {
          const stale = await tickets.require(ticketId);

          await customerReplies(5);

          return stale;
        },
      } as unknown as TicketQueryService;

      const racingCommands = new TicketCommandService(
        tenantPrisma,
        racing,
        tenantContext,
        new EventEmitter2(),
      );

      await expect(
        as(principalFor(TENANT_A, AGENT_A, 'agent'), async () =>
          racingCommands.update(REOPEN_WINS, { status: 'resolved' }),
        ),
      ).rejects.toBeInstanceOf(TicketStatusChangedConcurrentlyError);

      // The reopen stands and the agent's transition left no trace.
      expect(
        await as(principalFor(TENANT_A, AGENT_A, 'agent'), async () => tickets.get(REOPEN_WINS)),
      ).toMatchObject({ status: 'open', resolvedAt: null });
      expect(await eventsOn(REOPEN_WINS)).toEqual([
        {
          type: 'status_changed',
          actorUserId: null,
          data: { from: 'pending', to: 'open', cause: 'inbound_message' },
        },
      ]);
    });

    it('never leaves the contact with no active ticket when the resolve lands mid-attach', async () => {
      // The interleave the compare-and-set on the *linker's* side exists for,
      // and the one a sequential test cannot reach: the linker reads the ticket
      // as `pending`, the agent's PATCH to `resolved` commits, and the reopen
      // then matches nothing. Reporting `attached` there would record the
      // customer's reply against a finished ticket and leave the contact with
      // **zero** active tickets until they wrote again.
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');
      const racingLinker = linkerInterruptedAfterRead(async () =>
        as(agent, async () => commands.update(REOPEN_LOSES, { status: 'resolved' })),
      );

      const result = await customerReplies(10, racingLinker);

      // The reply opened a fresh ticket rather than landing on the resolved one.
      expect(result.outcome).toBe('created');
      expect(result.ticketId).not.toBe(REOPEN_LOSES);
      // `previousStatus` is null on a create — nothing tells TAR-26 to resume a
      // timer for a `pending → open` that never happened.
      expect(result.previousStatus).toBeNull();

      const held = await as(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), async () =>
        tenantPrisma.ticket.findMany({
          where: { contactId: CONTACTS[10] },
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true },
        }),
      );

      expect(held).toEqual([
        { id: REOPEN_LOSES, status: 'resolved' },
        { id: result.ticketId, status: 'open' },
      ]);
      // And the abandoned ticket carries the agent's move only: no reopen the
      // database refused, and no `conversation_linked` from the attempt that
      // walked away.
      expect(await eventsOn(REOPEN_LOSES)).toEqual([
        {
          type: 'status_changed',
          actorUserId: AGENT_A,
          data: { from: 'pending', to: 'resolved', cause: 'agent' },
        },
      ]);
    });

    it('opens a second ticket for the contact when the agent commits first', async () => {
      // The other ordering, and it is **not** a defect: 0003 has no reopen
      // window, so a customer writing back after resolution gets a new ticket.
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      await as(agent, async () => commands.update(AGENT_WINS, { status: 'resolved' }));

      await customerReplies(6);

      const held = await as(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), async () =>
        tenantPrisma.ticket.findMany({
          where: { contactId: CONTACTS[6] },
          orderBy: { createdAt: 'asc' },
          select: { id: true, status: true },
        }),
      );

      expect(held).toHaveLength(2);
      expect(held[0]).toEqual({ id: AGENT_WINS, status: 'resolved' });
      // A second, brand-new ticket rather than a reopen of the first.
      expect(held[1]?.status).toBe('open');
      expect(held[1]?.id).not.toBe(AGENT_WINS);
      // And the resolved one records the agent's move only — the linker wrote no
      // event against a ticket it never touched.
      expect(await eventsOn(AGENT_WINS)).toEqual([
        {
          type: 'status_changed',
          actorUserId: AGENT_A,
          data: { from: 'pending', to: 'resolved', cause: 'agent' },
        },
      ]);
    });
  });

  describe('permissions and visibility', () => {
    it('hides a colleague’s ticket from an agent without ticket:read_all', async () => {
      const agent = principalFor(TENANT_A, AGENT_A, 'agent');

      await expect(as(agent, async () => tickets.get(COLLEAGUES))).rejects.toBeInstanceOf(
        TicketNotFoundError,
      );
      // `not_found` on the write too, never `forbidden` — a 403 would confirm
      // the id names a real ticket somebody is working.
      await expect(
        as(agent, async () => commands.update(COLLEAGUES, { priority: 'urgent' })),
      ).rejects.toBeInstanceOf(TicketNotFoundError);
    });

    it('keeps an unassigned ticket out of an agent’s queue', async () => {
      // Tickets use the narrow rule: an unassigned ticket is triaged work, not a
      // shared pool, so browsing it needs `ticket:read_all`.
      const page = await queue(principalFor(TENANT_A, AGENT_A, 'agent'), { scope: 'unassigned' });

      expect(page.items.map((ticket) => ticket.id)).not.toContain(UNASSIGNED);
    });

    it('shows a supervisor the unassigned backlog, and nothing that is held', async () => {
      const page = await queue(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), {
        scope: 'unassigned',
      });

      // The seeded one, plus the ticket the linker auto-created in the race
      // block above — an auto-created ticket has no assignee until TAR-23
      // routes it, so it belongs in this backlog.
      expect(page.items.map((ticket) => ticket.id)).toContain(UNASSIGNED);
      expect(page.items.map((ticket) => ticket.id)).not.toContain(COLLEAGUES);
      expect(
        page.items.every(
          (ticket) => ticket.assignedUserId === null && ticket.assignedTeamId === null,
        ),
      ).toBe(true);
    });

    it('refuses a resolve to a principal holding ticket:update but not ticket:close', async () => {
      const triage = principalFor(
        TENANT_A,
        AGENT_A,
        'agent',
        permissionsForRole('agent').filter((permission) => permission !== 'ticket:close'),
      );

      await expect(
        as(triage, async () => commands.update(NORMAL_NEW, { status: 'resolved' })),
      ).rejects.toBeInstanceOf(TicketCloseNotPermittedError);
      expect(await eventsOn(NORMAL_NEW)).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('does not let tenant B read tenant A’s ticket', async () => {
      await expect(
        as(principalFor(TENANT_B, AGENT_B, 'supervisor'), async () => tickets.get(URGENT)),
      ).rejects.toBeInstanceOf(TicketNotFoundError);
    });

    it('does not let tenant B change tenant A’s ticket', async () => {
      await expect(
        as(principalFor(TENANT_B, AGENT_B, 'supervisor'), async () =>
          commands.update(URGENT, { status: 'closed' }),
        ),
      ).rejects.toBeInstanceOf(TicketNotFoundError);

      const untouched = await as(principalFor(TENANT_A, SUPERVISOR_A, 'supervisor'), async () =>
        tickets.get(URGENT),
      );

      expect(untouched).toMatchObject({ status: 'open', closedAt: null });
    });

    it('shows tenant B only its own queue', async () => {
      const page = await queue(principalFor(TENANT_B, AGENT_B, 'supervisor'));

      expect(page.items.map((ticket) => ticket.id)).toEqual([TENANT_B_TICKET]);
    });
  });
});

/** The conversation belonging to the contact at `index`, by construction of the fixture. */
function conversationFor(index: number): string {
  return `25444444-4444-7444-8444-4444444445${String(index).padStart(2, '0')}`;
}

async function seedFixture(systemPrisma: PrismaClient): Promise<void> {
  const now = Date.now();

  await systemPrisma.tenant.createMany({
    data: [
      { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-284 A', status: 'active' },
      { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-284 B', status: 'active' },
    ],
  });

  await systemPrisma.user.createMany({
    data: [
      {
        id: SUPERVISOR_A,
        tenantId: TENANT_A,
        email: 'sup-a@tar284.invalid',
        name: 'Sup A',
        role: 'supervisor',
        status: 'active',
      },
      {
        id: AGENT_A,
        tenantId: TENANT_A,
        email: 'a1@tar284.invalid',
        name: 'A1',
        role: 'agent',
        status: 'active',
      },
      {
        id: OTHER_AGENT_A,
        tenantId: TENANT_A,
        email: 'a2@tar284.invalid',
        name: 'A2',
        role: 'agent',
        status: 'active',
      },
      {
        id: AGENT_B,
        tenantId: TENANT_B,
        email: 'b1@tar284.invalid',
        name: 'B1',
        role: 'supervisor',
        status: 'active',
      },
    ],
  });

  await systemPrisma.whatsappBusinessAccount.createMany({
    data: [
      { id: WABA_A, tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a` },
      { id: WABA_B, tenantId: TENANT_B, wabaId: `${FIXTURE_PREFIX}-waba-b` },
    ],
  });

  await systemPrisma.whatsappAccount.createMany({
    data: [
      {
        id: NUMBER_A,
        tenantId: TENANT_A,
        whatsappBusinessAccountId: WABA_A,
        phoneNumberId: `${FIXTURE_PREFIX}-number-a`,
        displayPhoneNumber: '+10000028401',
      },
      {
        id: NUMBER_B,
        tenantId: TENANT_B,
        whatsappBusinessAccountId: WABA_B,
        phoneNumberId: `${FIXTURE_PREFIX}-number-b`,
        displayPhoneNumber: '+10000028402',
      },
    ],
  });

  await systemPrisma.contact.createMany({
    data: [
      ...CONTACTS.map((id, index) => ({
        id,
        tenantId: TENANT_A,
        phoneE164: `+9665000284${String(index).padStart(2, '0')}`,
        displayName: `Contact ${index}`,
      })),
      { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+966500028499', displayName: 'Neighbour' },
    ],
  });

  await systemPrisma.conversation.createMany({
    data: [
      ...CONTACTS.map((contactId, index) => ({
        id: conversationFor(index),
        tenantId: TENANT_A,
        whatsappAccountId: NUMBER_A,
        contactId,
        status: 'open' as const,
        lastMessageAt: new Date(now - HOUR_MS),
      })),
      {
        id: conversationFor(99),
        tenantId: TENANT_B,
        whatsappAccountId: NUMBER_B,
        contactId: CONTACT_B,
        status: 'open' as const,
        lastMessageAt: new Date(now - HOUR_MS),
      },
    ],
  });

  /**
   * `createdAt` is explicit on every row, because the queue's second sort key is
   * exactly this column and rows written in one statement otherwise share a
   * millisecond.
   */
  const seeded = [
    { id: URGENT, contact: 0, priority: 'urgent' as const, status: 'open' as const, ageHours: 5 },
    { id: HIGH, contact: 1, priority: 'high' as const, status: 'open' as const, ageHours: 4 },
    {
      id: NORMAL_NEW,
      contact: 2,
      priority: 'normal' as const,
      status: 'open' as const,
      ageHours: 1,
    },
    {
      id: NORMAL_OLD,
      contact: 3,
      priority: 'normal' as const,
      status: 'open' as const,
      ageHours: 3,
    },
    { id: PENDING, contact: 4, priority: 'normal' as const, status: 'open' as const, ageHours: 6 },
    {
      id: REOPEN_WINS,
      contact: 5,
      priority: 'normal' as const,
      status: 'pending' as const,
      ageHours: 7,
    },
    {
      id: AGENT_WINS,
      contact: 6,
      priority: 'normal' as const,
      status: 'pending' as const,
      ageHours: 8,
    },
    {
      id: COLLEAGUES,
      contact: 7,
      priority: 'normal' as const,
      status: 'open' as const,
      ageHours: 9,
    },
    {
      id: UNASSIGNED,
      contact: 8,
      priority: 'normal' as const,
      status: 'open' as const,
      ageHours: 10,
    },
    {
      id: REOPEN_LOSES,
      contact: 10,
      priority: 'normal' as const,
      status: 'pending' as const,
      ageHours: 11,
    },
    { id: LOW, contact: 9, priority: 'low' as const, status: 'open' as const, ageHours: 2 },
  ];

  await systemPrisma.ticket.createMany({
    data: [
      ...seeded.map((ticket, index) => ({
        id: ticket.id,
        tenantId: TENANT_A,
        number: index + 1,
        conversationId: conversationFor(ticket.contact),
        contactId: CONTACTS[ticket.contact],
        status: ticket.status,
        priority: ticket.priority,
        assignedUserId: assigneeFor(ticket.id),
        createdAt: new Date(now - ticket.ageHours * HOUR_MS),
      })),
      {
        id: TENANT_B_TICKET,
        tenantId: TENANT_B,
        number: 1,
        conversationId: conversationFor(99),
        contactId: CONTACT_B,
        status: 'open',
        priority: 'urgent',
        assignedUserId: AGENT_B,
        createdAt: new Date(now - HOUR_MS),
      },
    ],
  });

  // Past every seeded `number`, so the linker's allocator cannot collide with
  // one when the race test makes it create a real ticket.
  await systemPrisma.ticketCounter.createMany({
    data: [
      { tenantId: TENANT_A, nextNumber: NEXT_TICKET_NUMBER },
      { tenantId: TENANT_B, nextNumber: NEXT_TICKET_NUMBER },
    ],
  });
}

/** One ticket belongs to a colleague and one to nobody; the rest are the agent's. */
function assigneeFor(ticketId: string): string | null {
  if (ticketId === COLLEAGUES) {
    return OTHER_AGENT_A;
  }

  return ticketId === UNASSIGNED ? null : AGENT_A;
}

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
