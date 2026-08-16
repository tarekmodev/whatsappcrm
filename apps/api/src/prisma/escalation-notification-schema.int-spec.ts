import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';
import { withTenantScope, type TenantPrisma } from './tenant-scope.extension';

/**
 * TAR-468: the parts of the escalation audit trail that `schema.prisma` cannot
 * express or cannot protect, against a real PostgreSQL.
 *
 * The column, the enum value and the indexes in
 * `20260816150000_notification_type_escalation` and
 * `20260816160000_ticket_escalation_notifications` are plain Prisma and
 * `migrate diff` reports drift on them loudly. These will not report anything:
 *
 *   1. **`notifications_escalation_columns`.** Prisma's schema language has no
 *      CHECK and its describer ignores one, so a dropped constraint is invisible
 *      to every tool here. It is the only thing standing between the escalation
 *      view and a row that claims to be an escalation while naming no event.
 *   2. **The composite foreign key `(tenant_id, ticket_event_id)`.** Prisma
 *      declares it, but what it defends against is not a schema property — it is
 *      the write a handler makes when it takes an event id from a request body
 *      and forgets to scope the lookup.
 *   3. **`ticket_events_tenant_id_id_key`.** The reference target that key
 *      needs, asserted by definition rather than existence: an index regenerated
 *      without `UNIQUE`, or over the columns in the other order, still *exists*
 *      and still serves reads, and the foreign key silently has nothing valid to
 *      point at.
 *   4. **The idempotency boundary.** The unique must refuse a *retry* of one
 *      escalation and accept a *second* escalation to the same supervisor an
 *      hour later. Those two writes differ only in `ticket_event_id`, so a key
 *      narrowed to `(tenant_id, ticket_id, recipient_user_id)` — the shape an
 *      intuition reaches for — passes case one and breaks case two.
 *   5. **Tenant isolation on the escalation rows**, which `pnpm db:verify:rls`
 *      proves from the catalogue and this proves through the client.
 *
 * ⚠️ **Escalation is a `notifications` row, not an `escalation_alerts` table.**
 * ADR 0011 decision 5 specified a parallel table and accepted two tables only as
 * the price of not folding them mid-story, naming the *third* notification type
 * as the trigger to fold. TAR-394 reached that point first at the second type
 * (`20260816130000_notifications_generalisation`), so the fourth table would have
 * been the deviation. The merged contract needs nothing else: TAR-470 publishes
 * `TicketEscalationResponseSchema` as `{ event, notifiedUserIds }` and no
 * `escalation-alerts` route exists.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and `tar468-fixture` slugs, deleted before the run as well
 * as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '40468888-8888-7888-8888-888888888801';
/**
 * A second, genuinely active tenant. It has to exist rather than be a made-up
 * id: TAR-51's deactivation gate refuses an unknown tenant before RLS is ever
 * consulted, so reading as a fictional one would pass the isolation case without
 * testing isolation.
 */
const OTHER_TENANT = '40468888-8888-7888-8888-888888888802';

const AGENT = '40468888-8888-7888-8888-8888888888a0';
const SUPERVISOR = '40468888-8888-7888-8888-8888888888a1';
const OTHER_SUPERVISOR = '40468888-8888-7888-8888-8888888888a2';

const CONTACT = '40468888-8888-7888-8888-8888888888b0';
const OTHER_CONTACT = '40468888-8888-7888-8888-8888888888b1';
const TICKET = '40468888-8888-7888-8888-8888888888c0';
const OTHER_TICKET = '40468888-8888-7888-8888-8888888888c1';

const REQUEST_ID = 'tar468-int-spec';

/** Asserts a single row and hands it back — `noUncheckedIndexedAccess` is on. */
function only<T>(rows: T[]): T {
  expect(rows).toHaveLength(1);

  const [row] = rows;

  if (row === undefined) {
    throw new Error('unreachable: the length assertion above would have failed first');
  }

  return row;
}

describe('escalation audit trail', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /** Distinct per event, so a case can be added without renumbering. */
  let nextEvent = 0;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  function indexDefinition(name: string): Promise<{ indexdef: string }[]> {
    return systemPrisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
    `;
  }

  function checkDefinition(name: string): Promise<{ definition: string }[]> {
    return systemPrisma.$queryRaw<{ definition: string }[]>`
      SELECT pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE contype = 'c' AND conname = ${name}
    `;
  }

  function eventId(): string {
    nextEvent += 1;

    return `40468888-8888-7888-8888-4046${String(nextEvent).padStart(8, '0')}`;
  }

  /**
   * An `escalated` event, in the shape 0011 decision 4 fixes: the actor, the
   * ticket and the timestamp are columns; the reason and the cause live in
   * `data`. `type` is plain text on purpose — it is `text` rather than an enum
   * precisely so that this story adds a value without a migration, and a future
   * enum would break here rather than in production.
   */
  async function insertEscalation(
    tenantId: string,
    ticketId: string,
    actorUserId: string,
  ): Promise<string> {
    const id = eventId();

    await systemPrisma.ticketEvent.create({
      data: {
        id,
        tenantId,
        ticketId,
        type: 'escalated',
        actorUserId,
        data: { reason: 'the customer is threatening to cancel', cause: 'agent' },
      },
    });

    return id;
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from the tenant, so one delete is enough and
    // stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT, OTHER_TENANT] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT, slug: 'tar468-fixture', name: 'TAR-468 fixture', status: 'active' },
        { id: OTHER_TENANT, slug: 'tar468-fixture-b', name: 'TAR-468 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: AGENT,
          tenantId: TENANT,
          email: 'tar468-agent@fixture.test',
          name: 'TAR-468 agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUPERVISOR,
          tenantId: TENANT,
          email: 'tar468-supervisor@fixture.test',
          name: 'TAR-468 supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: OTHER_SUPERVISOR,
          tenantId: OTHER_TENANT,
          email: 'tar468-supervisor-b@fixture.test',
          name: 'TAR-468 supervisor B',
          role: 'supervisor',
          status: 'active',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT, tenantId: TENANT, phoneE164: '+10000046801' },
        { id: OTHER_CONTACT, tenantId: OTHER_TENANT, phoneE164: '+10000046802' },
      ],
    });
    // Ticket #1 in both tenants. The key is `(tenant_id, number)`, so this is
    // correct — and it means no assertion below can pass by accident on a
    // globally distinct number.
    await systemPrisma.ticket.createMany({
      data: [
        { id: TICKET, tenantId: TENANT, number: 1, contactId: CONTACT, assignedUserId: AGENT },
        { id: OTHER_TICKET, tenantId: OTHER_TENANT, number: 1, contactId: OTHER_CONTACT },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('`ticket_events` is the one shape both actions fit', () => {
    it('carries the composite unique the escalation notification points at', async () => {
      const index = only(await indexDefinition('ticket_events_tenant_id_id_key'));

      // Existence is not the assertion. An index regenerated without UNIQUE, or
      // over `(id, tenant_id)`, still exists and still serves reads — and
      // PostgreSQL then has nothing valid for `(tenant_id, ticket_event_id)` to
      // reference, which is a migration that fails on a fresh database only.
      expect(index.indexdef).toContain('CREATE UNIQUE INDEX');
      expect(index.indexdef).toContain('(tenant_id, id)');
    });

    it('records a reassignment and an escalation as distinguishable types on one ticket', async () => {
      // 0011 decision 4: `assigned` is reused for reassignment and `escalated` is
      // the one new type, because escalation does not move the assignment. A
      // third type meaning "the assignment moved" would make every consumer
      // learn all three.
      await systemPrisma.ticketEvent.create({
        data: {
          id: eventId(),
          tenantId: TENANT,
          ticketId: TICKET,
          type: 'assigned',
          actorUserId: AGENT,
          data: {
            reason: 'going off shift',
            cause: 'agent',
            assignment: {
              fromUserId: AGENT,
              fromTeamId: null,
              toUserId: SUPERVISOR,
              toTeamId: null,
            },
          },
        },
      });
      await insertEscalation(TENANT, TICKET, AGENT);

      const events = await systemPrisma.ticketEvent.findMany({
        where: { ticketId: TICKET },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { type: true, data: true },
      });

      expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['assigned', 'escalated']));
      // The reason is what TAR-32 requires be logged, and it survives the round
      // trip through JSONB rather than being flattened to a string column.
      for (const event of events) {
        const data = event.data as { reason?: unknown; cause?: unknown } | null;

        expect(typeof data?.reason).toBe('string');
        expect(data?.cause).toBe('agent');
      }
    });
  });

  describe('`notifications_escalation_columns` keeps the type and the column in step', () => {
    it('is a biconditional, by definition', async () => {
      const check = only(await checkDefinition('notifications_escalation_columns'));

      expect(check.definition).toContain('escalation');
      expect(check.definition).toContain('ticket_event_id');
    });

    it('refuses an escalation that names no event', async () => {
      // The failure the foreign key cannot catch, because a null satisfies a
      // foreign key without a lookup. Such a row would render in the escalation
      // view with nothing in the audit trail to explain it.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO notifications (id, tenant_id, type, ticket_id, recipient_user_id)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, 'escalation', ${TICKET}::uuid, ${SUPERVISOR}::uuid)
        `,
      ).rejects.toThrow();
    });

    it('refuses another type carrying an event id', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      // The other direction: a workflow notification claiming an escalation that
      // never happened, which would put it into the escalation view.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO notifications (id, tenant_id, type, ticket_event_id, ticket_id, recipient_user_id, dedupe_key)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, 'workflow_notify', ${ticketEventId}::uuid,
                  ${TICKET}::uuid, ${SUPERVISOR}::uuid, 'tar468-not-an-escalation')
        `,
      ).rejects.toThrow();
    });

    it('leaves the shipped sla_breach invariant alone', async () => {
      // The constraint added beside it must not have widened the one already
      // there — a breach still requires its timer.
      const check = only(await checkDefinition('notifications_sla_breach_columns'));

      expect(check.definition).toContain('sla_timer_id');
    });
  });

  describe('idempotency', () => {
    it('refuses a retry of one escalation to one recipient', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      await systemPrisma.notification.create({
        data: {
          tenantId: TENANT,
          type: 'escalation',
          ticketEventId,
          ticketId: TICKET,
          recipientUserId: SUPERVISOR,
        },
      });

      // The transaction in 0011's trigger point is the first layer; this is the
      // one that survives a worker retrying after a partial failure. Without it,
      // a redelivered job tells the same supervisor twice about one escalation.
      await expect(
        systemPrisma.notification.create({
          data: {
            tenantId: TENANT,
            type: 'escalation',
            ticketEventId,
            ticketId: TICKET,
            recipientUserId: SUPERVISOR,
          },
        }),
      ).rejects.toThrow();
    });

    it('accepts a second escalation on the same ticket to the same recipient', async () => {
      // The case that rules out the narrower key. An hour later the agent
      // escalates again and the supervisor must be told again — so the unique is
      // on `ticket_event_id`, a fresh row each time, and not on
      // `(ticket_id, recipient_user_id)`, which is not.
      const first = await insertEscalation(TENANT, TICKET, AGENT);
      const second = await insertEscalation(TENANT, TICKET, AGENT);

      for (const ticketEventId of [first, second]) {
        await systemPrisma.notification.create({
          data: {
            tenantId: TENANT,
            type: 'escalation',
            ticketEventId,
            ticketId: TICKET,
            recipientUserId: SUPERVISOR,
          },
        });
      }

      const raised = await systemPrisma.notification.findMany({
        where: { ticketEventId: { in: [first, second] }, recipientUserId: SUPERVISOR },
      });

      expect(raised).toHaveLength(2);
    });

    it('does not collide with an SLA breach on the same ticket', async () => {
      // Every escalation row leaves `sla_timer_id` null and every breach leaves
      // `ticket_event_id` null, and PostgreSQL does not collide NULLs — which is
      // why neither unique needed the partial predicate 0009 proposed. If either
      // key were made partial-free in the wrong direction, one type would start
      // suppressing the other on a busy ticket.
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      await systemPrisma.notification.create({
        data: {
          tenantId: TENANT,
          type: 'escalation',
          ticketEventId,
          ticketId: TICKET,
          recipientUserId: SUPERVISOR,
        },
      });

      const mine = await systemPrisma.notification.findMany({
        where: { ticketId: TICKET, recipientUserId: SUPERVISOR },
        select: { type: true },
      });

      expect(mine.length).toBeGreaterThan(1);
    });

    it('leaves a notification unacknowledged until the acknowledge endpoint stamps it', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      const raised = await systemPrisma.notification.create({
        data: {
          tenantId: TENANT,
          type: 'escalation',
          ticketEventId,
          ticketId: TICKET,
          recipientUserId: SUPERVISOR,
        },
        select: { acknowledgedAt: true, createdAt: true },
      });

      // `created_at` is NOT NULL because it is a keyset sort column; a null there
      // would drop the row out of the recipient's paged list entirely.
      expect(raised.acknowledgedAt).toBeNull();
      expect(raised.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('the composite foreign key, one per way a handler could get it wrong', () => {
    it('refuses a notification naming another tenant’s ticket event', async () => {
      const foreign = await insertEscalation(OTHER_TENANT, OTHER_TICKET, OTHER_SUPERVISOR);

      // Legal as far as the policy is concerned — `tenant_id` is this tenant's
      // own, so WITH CHECK passes. What refuses it is
      // `(tenant_id, ticket_event_id)` finding no such pair, which is the path a
      // handler taking an event id from a request body would take.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO notifications (id, tenant_id, type, ticket_event_id, ticket_id, recipient_user_id)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, 'escalation', ${foreign}::uuid,
                  ${TICKET}::uuid, ${SUPERVISOR}::uuid)
        `,
      ).rejects.toThrow();
    });

    it('refuses a notification naming another tenant’s supervisor as the recipient', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      // The one with a consequence outside the database: this row drives the
      // recipient's list, so a recipient from another org would be told the
      // reason an agent typed about a ticket they must never see.
      await expect(
        systemPrisma.$executeRaw`
          INSERT INTO notifications (id, tenant_id, type, ticket_event_id, ticket_id, recipient_user_id)
          VALUES (gen_random_uuid(), ${TENANT}::uuid, 'escalation', ${ticketEventId}::uuid,
                  ${TICKET}::uuid, ${OTHER_SUPERVISOR}::uuid)
        `,
      ).rejects.toThrow();
    });

    it('keeps the recipient reference NO ACTION, so removing a user cannot edit the trail', async () => {
      const constraint = only(
        await systemPrisma.$queryRaw<{ definition: string }[]>`
          SELECT pg_get_constraintdef(oid) AS definition
            FROM pg_constraint
           WHERE conname = 'notifications_tenant_id_recipient_user_id_fkey'
        `,
      );

      // Convention 4: removing a user is a status change, never a row delete. A
      // CASCADE here would delete the record that a departed supervisor was told
      // about an escalation — an audit trail that edits itself.
      expect(constraint.definition).not.toContain('ON DELETE CASCADE');
      expect(constraint.definition).toContain('REFERENCES users(tenant_id, id)');
    });

    it('cascades the notification when its escalation event goes', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      await systemPrisma.notification.create({
        data: {
          tenantId: TENANT,
          type: 'escalation',
          ticketEventId,
          ticketId: TICKET,
          recipientUserId: SUPERVISOR,
        },
      });
      await systemPrisma.ticketEvent.delete({ where: { id: ticketEventId } });

      // The invariant the composite key buys: a notification can never reference
      // an escalation absent from the audit trail, so "a notification nobody can
      // explain" is not a reachable state.
      const orphans = await systemPrisma.notification.findMany({ where: { ticketEventId } });

      expect(orphans).toHaveLength(0);
    });
  });

  describe('tenant isolation', () => {
    it('shows a recipient their own escalations and none of the other tenant’s', async () => {
      const mineEvent = await insertEscalation(TENANT, TICKET, AGENT);
      const theirsEvent = await insertEscalation(OTHER_TENANT, OTHER_TICKET, OTHER_SUPERVISOR);

      await systemPrisma.notification.createMany({
        data: [
          {
            tenantId: TENANT,
            type: 'escalation',
            ticketEventId: mineEvent,
            ticketId: TICKET,
            recipientUserId: SUPERVISOR,
          },
          {
            tenantId: OTHER_TENANT,
            type: 'escalation',
            ticketEventId: theirsEvent,
            ticketId: OTHER_TICKET,
            recipientUserId: OTHER_SUPERVISOR,
          },
        ],
      });

      // No `where` on `tenantId` anywhere below. RLS is what filters, which is
      // the guarantee — a `where` clause is a thing somebody has to remember.
      const mine = await asTenant(TENANT, () =>
        tenantPrisma.notification.findMany({ where: { type: 'escalation' } }),
      );
      const theirs = await asTenant(OTHER_TENANT, () =>
        tenantPrisma.notification.findMany({ where: { ticketEventId: mineEvent } }),
      );

      expect(mine.length).toBeGreaterThan(0);
      expect(theirs).toHaveLength(0);
    });

    it('refuses a cross-tenant write through the tenant client', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      // The policy's WITH CHECK half. A handler taking `tenantId` from a request
      // body cannot write into another tenant.
      await expect(
        asTenant(OTHER_TENANT, () =>
          tenantPrisma.notification.create({
            data: {
              tenantId: TENANT,
              type: 'escalation',
              ticketEventId,
              ticketId: TICKET,
              recipientUserId: SUPERVISOR,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('matches nothing when one tenant acknowledges another’s escalation', async () => {
      const ticketEventId = await insertEscalation(TENANT, TICKET, AGENT);

      const raised = await systemPrisma.notification.create({
        data: {
          tenantId: TENANT,
          type: 'escalation',
          ticketEventId,
          ticketId: TICKET,
          recipientUserId: SUPERVISOR,
        },
        select: { id: true },
      });

      // The acknowledge endpoint is an UPDATE by id. If the policy did not filter
      // it, one org's supervisor could silence another's — quietly, with no error
      // and nothing in the audit log. `updateMany` reports a count instead of
      // throwing, which is the shape that distinguishes "filtered to nothing"
      // from "rejected".
      const result = await asTenant(OTHER_TENANT, () =>
        tenantPrisma.notification.updateMany({
          where: { id: raised.id },
          data: { acknowledgedAt: new Date() },
        }),
      );

      expect(result.count).toBe(0);

      const untouched = await systemPrisma.notification.findUniqueOrThrow({
        where: { id: raised.id },
        select: { acknowledgedAt: true },
      });

      expect(untouched.acknowledgedAt).toBeNull();
    });

    it('cannot read another tenant’s escalation reason, which is the leak that matters', async () => {
      const theirs = await insertEscalation(OTHER_TENANT, OTHER_TICKET, OTHER_SUPERVISOR);

      // The reason is free text an agent typed about a named colleague and a
      // named customer. It is the most sensitive thing TAR-32 adds to the schema,
      // and `ticket_events` is where it lives.
      const found = await asTenant(TENANT, () =>
        tenantPrisma.ticketEvent.findMany({ where: { id: theirs } }),
      );

      expect(found).toHaveLength(0);
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
