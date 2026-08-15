import type {
  FallbackAssignmentDecision,
  FallbackAssignmentRequest,
  FallbackAssignmentResolver,
  RoutingCondition,
  TicketRoutingTrigger,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import { TicketNotVisibleError } from './assignment.errors';
import { RuleEngineService } from './rule-engine.service';

/**
 * TAR-288's four acceptance criteria, minus the one only a database can answer.
 *
 * Single match, priority ordering with several matches, and the no-match
 * fallback call are all here; cross-tenant isolation is in
 * `routing-rules.int-spec.ts`, because it depends on the GUC being set on the
 * same connection as the statement and on policies a mock cannot have.
 *
 * The prisma double is a hand-written fake rather than jest mocks, matching
 * `teams.service.spec.ts`: the real service body runs, so the order it reads in,
 * the compare-and-set it writes with, and the events it appends are all under
 * test rather than stubbed past.
 *
 * The fake holds the ticket as one **mutable row** and applies what the engine
 * writes to it, which is what lets a second `routeTicket` in the same world see
 * the first one's work — the property both idempotence claims rest on, the
 * assignment guard and 0008 amendment 1's first-transition-only deferral. What
 * it cannot answer is `tickets_routing_deferred_consistent`: a constraint is a
 * database's opinion, so those cases are in `routing-rules.int-spec.ts` too.
 */

const TENANT = '0192f0ff-0000-7000-8000-0000000000b1';
const TICKET = '0192f0ff-0000-7000-8000-00000000c001';
const CONTACT = '0192f0ff-0000-7000-8000-00000000d001';
const MESSAGE = '0192f0ff-0000-7000-8000-00000000e001';
const BILLING_TEAM = '0192f0ff-0000-7000-8000-0000000000t1';
const SALES_TEAM = '0192f0ff-0000-7000-8000-0000000000t2';
const SARA = '0192f0ff-0000-7000-8000-0000000000u1';
const ROTATED_TO = '0192f0ff-0000-7000-8000-0000000000u9';

const TRIGGER: TicketRoutingTrigger = {
  tenantId: TENANT,
  ticketId: TICKET,
  contactId: CONTACT,
  messageId: MESSAGE,
  createdAt: '2026-08-10T09:00:00.000Z',
};

const KEYWORD = (...values: string[]): RoutingCondition => ({
  type: 'keyword',
  match: 'any',
  values,
});

interface RuleFixture {
  id: string;
  name: string;
  position: number;
  conditions: unknown;
  targetUserId?: string | null;
  targetTeamId?: string | null;
}

/** The columns the engine reads and writes, as one mutable row the fake keeps. */
interface TicketRow {
  id: string;
  status: string;
  contactId: string | null;
  assignedUserId: string | null;
  assignedTeamId: string | null;
  routingState: string;
  routingDeferredReason: string | null;
  routingDeferredSince: Date | null;
  createdAt: Date;
}

interface WorldOptions {
  rules?: RuleFixture[];
  ticket?: Partial<TicketRow>;
  messageBody?: string | null;
  /**
   * The contact row the engine reads, or `null` for a contact that is not
   * visible. Defaults to one whose `custom_fields` column is null — the shape
   * every contact auto-created from a first inbound message has.
   */
  contact?: { customFields: unknown } | null;
  /** Users the tenant has, by id, with the status the engine reads. */
  users?: Record<string, string>;
  /** Teams that have at least one active member. */
  teamsWithActiveMembers?: string[];
  decision?: FallbackAssignmentDecision;
  /** Somebody else assigned the ticket between the read and the write. */
  loseTheCompareAndSet?: boolean;
}

interface Written {
  assignments: { assignedUserId: string | null; assignedTeamId: string | null }[];
  events: { type: string; data: Record<string, unknown> }[];
  fallbackRequests: FallbackAssignmentRequest[];
  /** Every table the engine actually read, so the lazy-read claim is testable. */
  read: string[];
  /**
   * `UPDATE`s against `tickets`, matched or not. One per branch: the routing
   * columns ride in the statement that already exists rather than in a second
   * one, which is what `tickets_routing_deferred_consistent` requires.
   */
  ticketUpdates: number;
}

const NOBODY: FallbackAssignmentDecision = {
  outcome: 'no_eligible_agent',
  userId: null,
  teamId: null,
  reason: 'none_available',
};

function buildWorld(options: WorldOptions = {}): {
  engine: RuleEngineService;
  written: Written;
  /** The row as the writes left it — the only place routing state is asserted. */
  ticket: TicketRow;
} {
  const written: Written = {
    assignments: [],
    events: [],
    fallbackRequests: [],
    read: [],
    ticketUpdates: 0,
  };

  const rules = (options.rules ?? []).map((rule) => ({
    targetUserId: null,
    targetTeamId: null,
    ...rule,
  }));

  const ticket: TicketRow = {
    id: TICKET,
    status: 'open',
    contactId: CONTACT,
    assignedUserId: null,
    assignedTeamId: null,
    routingState: 'pending',
    routingDeferredReason: null,
    routingDeferredSince: null,
    createdAt: new Date(TRIGGER.createdAt),
    ...options.ticket,
  };

  const tx = {
    ticket: {
      updateMany: ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Partial<TicketRow>;
      }) => {
        // Both guards the engine relies on are honoured here rather than
        // hard-coded: a ticket that is already assigned, and one that is already
        // `deferred`, match nothing and the row is left alone. Applying the
        // `data` is what makes a second `routeTicket` in the same world see what
        // the first one wrote — which is the whole of the idempotence claim.
        const won = matchesWhere(ticket, where) && options.loseTheCompareAndSet !== true;

        written.ticketUpdates += 1;

        if (won) {
          if ('assignedUserId' in data) {
            written.assignments.push({
              assignedUserId: data.assignedUserId ?? null,
              assignedTeamId: data.assignedTeamId ?? null,
            });
          }
          Object.assign(ticket, data);
        }

        return Promise.resolve({ count: won ? 1 : 0 });
      },
    },
    ticketEvent: {
      create: ({ data }: { data: { type: string; data: Record<string, unknown> } }) => {
        written.events.push({ type: data.type, data: data.data });
        return Promise.resolve({});
      },
    },
  };

  const prisma = {
    ticket: {
      findUnique: () => {
        written.read.push('ticket');
        return Promise.resolve(options.ticket === null ? null : ticket);
      },
    },
    assignmentRule: {
      findMany: () => {
        written.read.push('assignmentRule');
        // The fake returns them in the order the fixture lists them, which is
        // what the real `orderBy: [position, id]` produces. A test that wants to
        // assert the ordering asserts on the query, below.
        return Promise.resolve([...rules].sort(byEvaluationOrder));
      },
    },
    message: {
      findUnique: () => {
        written.read.push('message');
        return Promise.resolve({ body: options.messageBody ?? null });
      },
    },
    contactTag: {
      findMany: () => {
        written.read.push('contactTag');
        return Promise.resolve([]);
      },
    },
    contact: {
      findUnique: () => {
        written.read.push('contact');
        return Promise.resolve(
          options.contact === undefined ? { customFields: null } : options.contact,
        );
      },
    },
    tenantSettings: {
      findUnique: () => {
        written.read.push('tenantSettings');
        return Promise.resolve({ businessHours: null, timezone: 'Europe/London' });
      },
    },
    user: {
      findUnique: ({ where }: { where: { tenantId_id: { id: string } } }) => {
        const status = (options.users ?? {})[where.tenantId_id.id];

        return Promise.resolve(status === undefined ? null : { status });
      },
    },
    teamMember: {
      findFirst: ({ where }: { where: { teamId: string } }) =>
        Promise.resolve(
          (options.teamsWithActiveMembers ?? []).includes(where.teamId) ? { id: 'member' } : null,
        ),
    },
    $tenantTransaction: <T>(work: (client: unknown) => Promise<T>) => work(tx),
  } as unknown as TenantPrisma;

  const tenantContext = {
    requireTenantId: () => TENANT,
  } as unknown as TenantContextService;

  const fallback: FallbackAssignmentResolver = {
    resolveFallbackAssignment: (request) => {
      written.fallbackRequests.push(request);
      return Promise.resolve(options.decision ?? NOBODY);
    },
  };

  return { engine: new RuleEngineService(prisma, tenantContext, fallback), written, ticket };
}

function byEvaluationOrder(left: RuleFixture, right: RuleFixture): number {
  return left.position - right.position || left.id.localeCompare(right.id);
}

/**
 * The `where` of an `updateMany`, evaluated against the row.
 *
 * Generic over the columns rather than a check per call site, so a guard the
 * engine adds later is honoured by the fake without an edit here. It covers
 * exactly the two forms the engine uses — a literal, and Prisma's `{ not }` —
 * and `tenantId`, which names a row's owner rather than one of its columns.
 */
function matchesWhere(row: TicketRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([column, expected]) => {
    if (column === 'tenantId') {
      return expected === TENANT;
    }

    const actual = row[column as keyof TicketRow];

    return expected !== null && typeof expected === 'object'
      ? actual !== (expected as { not: unknown }).not
      : actual === expected;
  });
}

describe('routing a created ticket', () => {
  it('routes to the target of the one rule that matches', async () => {
    const { engine, written } = buildWorld({
      rules: [
        {
          id: 'r1',
          name: 'Billing keywords',
          position: 0,
          conditions: [KEYWORD('invoice')],
          targetTeamId: BILLING_TEAM,
        },
      ],
      messageBody: 'where is my invoice',
      teamsWithActiveMembers: [BILLING_TEAM],
    });

    const result = await engine.routeTicket(TRIGGER);

    expect(result).toEqual({
      outcome: 'routed',
      ruleId: 'r1',
      assignedUserId: null,
      assignedTeamId: BILLING_TEAM,
      reason: null,
    });
    expect(written.assignments).toEqual([{ assignedUserId: null, assignedTeamId: BILLING_TEAM }]);
    // Never rotation as well: a matched rule is terminal (0007, decision 4).
    expect(written.fallbackRequests).toHaveLength(0);
  });

  it('names the rule in the ticket event, so a supervisor can see why', async () => {
    const { engine, written } = buildWorld({
      rules: [
        {
          id: 'r1',
          name: 'Billing keywords',
          position: 0,
          conditions: [KEYWORD('invoice')],
          targetTeamId: BILLING_TEAM,
        },
      ],
      messageBody: 'invoice',
      teamsWithActiveMembers: [BILLING_TEAM],
    });

    await engine.routeTicket(TRIGGER);

    expect(written.events).toEqual([
      {
        type: 'assigned',
        data: {
          reason: 'Routed by rule "Billing keywords"',
          ruleId: 'r1',
          assignedUserId: null,
          assignedTeamId: BILLING_TEAM,
        },
      },
    ]);
  });

  it('assigns a user target to the user column and leaves the team column null', async () => {
    const { engine, written } = buildWorld({
      rules: [
        {
          id: 'r1',
          name: 'To Sara',
          position: 0,
          conditions: [KEYWORD('invoice')],
          targetUserId: SARA,
        },
      ],
      messageBody: 'invoice',
      users: { [SARA]: 'active' },
    });

    await engine.routeTicket(TRIGGER);

    // Writing both would make "assigned to" ambiguous for every consumer of the
    // visibility predicate.
    expect(written.assignments).toEqual([{ assignedUserId: SARA, assignedTeamId: null }]);
  });

  describe('when several rules match', () => {
    const TWO_MATCHING = [
      {
        id: 'r2',
        name: 'Sales second',
        position: 5,
        conditions: [KEYWORD('invoice')],
        targetTeamId: SALES_TEAM,
      },
      {
        id: 'r1',
        name: 'Billing first',
        position: 1,
        conditions: [KEYWORD('invoice')],
        targetTeamId: BILLING_TEAM,
      },
    ];

    it('takes the lowest position, and stops there', async () => {
      const { engine, written } = buildWorld({
        rules: TWO_MATCHING,
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM, SALES_TEAM],
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result.ruleId).toBe('r1');
      expect(result.assignedTeamId).toBe(BILLING_TEAM);
      expect(written.assignments).toHaveLength(1);
    });

    it('breaks a tie on id, which is creation order', async () => {
      // `position` defaults to 0 and has no unique constraint, so every rule
      // created without an explicit position ties with every other one. Without
      // the tie-break "which rule wins" would depend on the query plan.
      const { engine } = buildWorld({
        rules: [
          {
            id: '0192f0ff-0000-7000-8000-00000000r002',
            name: 'Created second',
            position: 0,
            conditions: [KEYWORD('invoice')],
            targetTeamId: SALES_TEAM,
          },
          {
            id: '0192f0ff-0000-7000-8000-00000000r001',
            name: 'Created first',
            position: 0,
            conditions: [KEYWORD('invoice')],
            targetTeamId: BILLING_TEAM,
          },
        ],
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM, SALES_TEAM],
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result.assignedTeamId).toBe(BILLING_TEAM);
    });

    it('skips a matching rule whose target cannot take work, and keeps going', async () => {
      // A team with no active members, or a suspended user. Assigning anyway
      // would leave the ticket invisible to every role without `_all` until
      // somebody noticed an alert; skipping puts it in front of the next rule
      // and ultimately rotation, immediately.
      const { engine, written } = buildWorld({
        rules: TWO_MATCHING,
        messageBody: 'invoice',
        teamsWithActiveMembers: [SALES_TEAM],
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result.ruleId).toBe('r2');
      expect(written.assignments).toEqual([{ assignedUserId: null, assignedTeamId: SALES_TEAM }]);
    });

    it('falls through to rotation when every matching rule has a broken target', async () => {
      const { engine, written } = buildWorld({
        rules: TWO_MATCHING,
        messageBody: 'invoice',
        teamsWithActiveMembers: [],
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result.outcome).toBe('deferred');
      expect(written.fallbackRequests).toHaveLength(1);
    });

    it('treats a suspended user target as unusable', async () => {
      const { engine } = buildWorld({
        rules: [
          {
            id: 'r1',
            name: 'To Sara',
            position: 0,
            conditions: [KEYWORD('invoice')],
            targetUserId: SARA,
          },
        ],
        messageBody: 'invoice',
        users: { [SARA]: 'suspended' },
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
    });
  });

  describe('when no rule matches', () => {
    const NON_MATCHING = [
      {
        id: 'r1',
        name: 'Billing keywords',
        position: 0,
        conditions: [KEYWORD('refund')],
        targetTeamId: BILLING_TEAM,
      },
    ];

    it('calls the fallback resolver — and this story stops there', async () => {
      const { engine, written } = buildWorld({
        rules: NON_MATCHING,
        messageBody: 'a question about delivery',
      });

      await engine.routeTicket(TRIGGER);

      expect(written.fallbackRequests).toEqual([
        {
          tenantId: TENANT,
          ticketId: TICKET,
          contactId: CONTACT,
          // Null: no rule matched, so there is no team in mind. The field is
          // carried for decision 4's rejected option, which TAR-24 does not take.
          teamId: null,
        },
      ]);
    });

    it('calls it for a tenant with no rules at all', async () => {
      const { engine, written } = buildWorld();

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
      expect(written.fallbackRequests).toHaveLength(1);
    });

    it('writes the assignment rotation decided on, and says it was rotation', async () => {
      const { engine, written } = buildWorld({
        rules: NON_MATCHING,
        messageBody: 'delivery',
        decision: {
          outcome: 'assigned',
          userId: ROTATED_TO,
          teamId: null,
          reason: null,
        },
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result).toEqual({
        outcome: 'fallback_assigned',
        ruleId: null,
        assignedUserId: ROTATED_TO,
        assignedTeamId: null,
        reason: null,
      });
      // The resolver decides; the engine writes. The assignment write stays in
      // one place because it is a compare-and-set that also appends the event.
      expect(written.assignments).toEqual([{ assignedUserId: ROTATED_TO, assignedTeamId: null }]);
      expect(written.events[0]?.data.reason).toBe('Assigned by rotation');
    });

    it('defers, with the reason on the event, when rotation had nobody', async () => {
      const { engine, written } = buildWorld({
        rules: NON_MATCHING,
        messageBody: 'delivery',
        decision: {
          outcome: 'no_eligible_agent',
          userId: null,
          teamId: null,
          reason: 'all_at_capacity',
        },
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result).toEqual({
        outcome: 'deferred',
        ruleId: null,
        assignedUserId: null,
        assignedTeamId: null,
        reason: 'all_at_capacity',
      });
      expect(written.assignments).toHaveLength(0);
      expect(written.events).toEqual([
        { type: 'assignment_deferred', data: { reason: 'all_at_capacity' } },
      ]);
    });

    it('does not write an assignment for a decision that claims `assigned` with no user', async () => {
      // A resolver breaking its own invariant. Treated as no assignment rather
      // than as a null write that would read as "this ticket is routed".
      const { engine, written } = buildWorld({
        rules: NON_MATCHING,
        messageBody: 'delivery',
        decision: { outcome: 'assigned', userId: null, teamId: null, reason: null },
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
      expect(written.assignments).toHaveLength(0);
    });
  });

  /**
   * 0008 amendment 1: the column the supervisor's queue reads, written by the
   * branch that decided it. Without these writes `routing_state` sits at its
   * migration default for the life of the ticket and
   * `?routingState=deferred` renders "nothing is stuck" over tickets that are.
   */
  describe('the routing state a supervisor’s queue reads', () => {
    const BILLING_RULE = {
      id: 'r1',
      name: 'Billing keywords',
      position: 0,
      conditions: [KEYWORD('invoice')],
      targetTeamId: BILLING_TEAM,
    };

    const AT_CAPACITY: FallbackAssignmentDecision = {
      outcome: 'no_eligible_agent',
      userId: null,
      teamId: null,
      reason: 'all_at_capacity',
    };

    it('flags a deferred ticket with its reason and the moment it got stuck', async () => {
      const { engine, written, ticket } = buildWorld({ decision: AT_CAPACITY });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
      expect(ticket.routingState).toBe('deferred');
      expect(ticket.routingDeferredReason).toBe('all_at_capacity');
      expect(ticket.routingDeferredSince).toBeInstanceOf(Date);
      // All three in one statement: the CHECK constraint ties the state to both
      // nullable columns, so a two-step write is rejected in between.
      expect(written.ticketUpdates).toBe(1);
      // And still unassigned — deferring is the absence of an assignment.
      expect(written.assignments).toHaveLength(0);
    });

    it('does not move `routing_deferred_since` when the job is redelivered', async () => {
      // The supervisor's ageing key. A redelivered job that reset it would make
      // an hour-old stuck ticket look like it arrived just now, and the original
      // timestamp is not recoverable — hence `routingState: { not: 'deferred' }`
      // in the `WHERE` rather than a read followed by a write.
      const { engine, written, ticket } = buildWorld();

      await engine.routeTicket(TRIGGER);
      const stuckSince = ticket.routingDeferredSince;
      await engine.routeTicket(TRIGGER);

      expect(stuckSince).toBeInstanceOf(Date);
      expect(ticket.routingDeferredSince).toBe(stuckSince);
      expect(ticket.routingDeferredReason).toBe('none_available');
      // The event log is a history, and a second deferral did happen. Only the
      // column write is first-transition-only.
      expect(written.events).toHaveLength(2);
    });

    it('marks a routed ticket `assigned` in the statement that assigns it', async () => {
      const { engine, written, ticket } = buildWorld({
        rules: [BILLING_RULE],
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      await engine.routeTicket(TRIGGER);

      expect(ticket.routingState).toBe('assigned');
      expect(ticket.routingDeferredReason).toBeNull();
      expect(ticket.routingDeferredSince).toBeNull();
      expect(written.ticketUpdates).toBe(1);
    });

    it('clears the deferred pair when a ticket that was stuck is finally assigned', async () => {
      // Why `assign` nulls the pair rather than leaving it: the row would carry
      // a stale "all at capacity" beside an assignment, which is what
      // `tickets_routing_deferred_consistent` exists to refuse.
      const { engine, ticket } = buildWorld({
        ticket: {
          routingState: 'deferred',
          routingDeferredReason: 'all_at_capacity',
          routingDeferredSince: new Date('2026-08-10T09:05:00.000Z'),
        },
        decision: { outcome: 'assigned', userId: ROTATED_TO, teamId: null, reason: null },
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('fallback_assigned');
      expect(ticket).toMatchObject({
        assignedUserId: ROTATED_TO,
        routingState: 'assigned',
        routingDeferredReason: null,
        routingDeferredSince: null,
      });
    });

    it('leaves all three columns untouched on a ticket it skips', async () => {
      // `manual` is terminal for routing, and `pending` on an already-assigned
      // ticket is TAR-272's backfill talking. Either way this branch decided
      // nothing, so it says nothing.
      const { engine, written, ticket } = buildWorld({
        rules: [BILLING_RULE],
        messageBody: 'invoice',
        ticket: { assignedUserId: SARA, routingState: 'manual' },
      });

      expect((await engine.routeTicket(TRIGGER)).reason).toBe('already_assigned');
      expect(ticket).toMatchObject({
        routingState: 'manual',
        routingDeferredReason: null,
        routingDeferredSince: null,
      });
      expect(written.ticketUpdates).toBe(0);
    });

    it('leaves them untouched when the compare-and-set loses the race', async () => {
      const { engine, ticket } = buildWorld({
        rules: [BILLING_RULE],
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM],
        loseTheCompareAndSet: true,
      });

      await engine.routeTicket(TRIGGER);

      // The supervisor who won the race owns the routing state too, and this
      // transaction moved no row — so it wrote no column either.
      expect(ticket.routingState).toBe('pending');
    });
  });

  describe('idempotence and the states it writes nothing for', () => {
    it('skips a ticket somebody already assigned', async () => {
      const { engine, written } = buildWorld({
        rules: [
          {
            id: 'r1',
            name: 'Billing',
            position: 0,
            conditions: [KEYWORD('invoice')],
            targetTeamId: BILLING_TEAM,
          },
        ],
        messageBody: 'invoice',
        ticket: { assignedUserId: SARA },
      });

      expect(await engine.routeTicket(TRIGGER)).toEqual({
        outcome: 'skipped',
        ruleId: null,
        assignedUserId: null,
        assignedTeamId: null,
        reason: 'already_assigned',
      });
      expect(written.events).toHaveLength(0);
      // The evaluation is skipped too — no rules are even loaded.
      expect(written.read).toEqual(['ticket']);
    });

    it('skips a resolved or closed ticket', async () => {
      const { engine } = buildWorld({ ticket: { status: 'resolved' } });

      expect((await engine.routeTicket(TRIGGER)).reason).toBe('ticket_not_active');
    });

    it('reports `already_assigned` when the compare-and-set loses the race', async () => {
      // A supervisor assigning by hand in the second between the read and the
      // write keeps their assignment, and the log never claims one that did not
      // happen — the event is appended only if the update moved a row.
      const { engine, written } = buildWorld({
        rules: [
          {
            id: 'r1',
            name: 'Billing',
            position: 0,
            conditions: [KEYWORD('invoice')],
            targetTeamId: BILLING_TEAM,
          },
        ],
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM],
        loseTheCompareAndSet: true,
      });

      expect((await engine.routeTicket(TRIGGER)).reason).toBe('already_assigned');
      expect(written.events).toHaveLength(0);
    });

    it('throws for a ticket that is not visible, so BullMQ retries', async () => {
      // The realistic cause is this job overtaking the transaction that created
      // its ticket. The other cause is a payload naming another tenant's ticket,
      // which reads nothing under RLS and lands here too.
      const { engine } = buildWorld({ ticket: null as never });

      await expect(engine.routeTicket(TRIGGER)).rejects.toThrow(TicketNotVisibleError);
    });
  });

  describe('bad data falls through instead of failing', () => {
    it('skips a rule whose stored conditions do not parse', async () => {
      const { engine, written } = buildWorld({
        rules: [
          {
            id: 'r1',
            name: 'Corrupt',
            position: 0,
            conditions: [{ type: 'astrology', sign: 'leo' }],
            targetTeamId: BILLING_TEAM,
          },
          {
            id: 'r2',
            name: 'Billing',
            position: 1,
            conditions: [KEYWORD('invoice')],
            targetTeamId: SALES_TEAM,
          },
        ],
        messageBody: 'invoice',
        teamsWithActiveMembers: [BILLING_TEAM, SALES_TEAM],
      });

      // The failure mode of a routing engine has to be "this ticket went to
      // rotation", never "the queue stopped".
      expect((await engine.routeTicket(TRIGGER)).ruleId).toBe('r2');
      expect(written.assignments).toEqual([{ assignedUserId: null, assignedTeamId: SALES_TEAM }]);
    });
  });

  describe('a contact whose custom fields have never been set', () => {
    // `contacts.custom_fields` is nullable, and every contact auto-created from a
    // first inbound WhatsApp message leaves it null. Reading that as "there is no
    // contact" made `is_not_set` false for exactly the brand-new customers a rule
    // like "plan_tier is not set → Onboarding" is written for — and it looked
    // correct in any test written against a contact somebody had edited once,
    // because an edit writes `{}` or a populated object.
    const IS_NOT_SET: RoutingCondition = {
      type: 'contact_attribute',
      key: 'plan_tier',
      operator: 'is_not_set',
      value: null,
    };

    const onPlanTier = (operator: 'is_set' | 'is_not_set'): RuleFixture[] => [
      {
        id: 'r1',
        name: 'Unknown plan to Onboarding',
        position: 0,
        conditions: [{ ...IS_NOT_SET, operator }],
        targetTeamId: BILLING_TEAM,
      },
    ];

    const ONBOARDING = onPlanTier('is_not_set');

    it('matches `is_not_set` when the column is null', async () => {
      const { engine, written } = buildWorld({
        rules: ONBOARDING,
        contact: { customFields: null },
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      const result = await engine.routeTicket(TRIGGER);

      expect(result).toMatchObject({ outcome: 'routed', assignedTeamId: BILLING_TEAM });
      expect(written.assignments).toEqual([{ assignedUserId: null, assignedTeamId: BILLING_TEAM }]);
    });

    it('matches it the same way when the column holds an empty object', async () => {
      // The state an edit that cleared every field leaves behind. The two have to
      // agree — a supervisor cannot see which one a contact is in.
      const { engine } = buildWorld({
        rules: ONBOARDING,
        contact: { customFields: {} },
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('routed');
    });

    it('does not match `is_set` on the same contact', async () => {
      const { engine } = buildWorld({
        rules: onPlanTier('is_set'),
        contact: { customFields: null },
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
    });

    it('still refuses to answer for a ticket that has no contact at all', async () => {
      // The distinction the fix turns on: nothing to read is not the same as
      // nothing set, and `is_not_set` stays false here (0007's "no data to read
      // is false"). The contact is never queried.
      const { engine, written } = buildWorld({
        rules: ONBOARDING,
        ticket: { contactId: null },
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
      expect(written.read).not.toContain('contact');
    });

    it('refuses to answer for a contact row that is not visible', async () => {
      const { engine } = buildWorld({
        rules: ONBOARDING,
        contact: null,
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
    });

    it('refuses to answer for custom fields that do not parse', async () => {
      // Corrupt data, not an empty field. Answering `is_not_set` from it would be
      // a guess about what the row was meant to hold.
      const { engine } = buildWorld({
        rules: ONBOARDING,
        contact: { customFields: { plan_tier: { nested: 'object' } } },
        teamsWithActiveMembers: [BILLING_TEAM],
      });

      expect((await engine.routeTicket(TRIGGER)).outcome).toBe('deferred');
    });
  });

  describe('the reads it does not do', () => {
    it('reads neither contact nor message for a tenant whose rules are all business-hours', async () => {
      const { engine, written } = buildWorld({
        rules: [
          {
            id: 'r1',
            name: 'Out of hours',
            position: 0,
            conditions: [{ type: 'business_hours', within: false }],
            targetTeamId: BILLING_TEAM,
          },
        ],
      });

      await engine.routeTicket(TRIGGER);

      expect(written.read).toEqual(['ticket', 'assignmentRule', 'tenantSettings']);
    });

    it('reads the message once for a keyword rule, not once per rule', async () => {
      const { engine, written } = buildWorld({
        rules: [1, 2, 3].map((n) => ({
          id: `r${n}`,
          name: `Rule ${n}`,
          position: n,
          conditions: [KEYWORD(`nothing-${n}`)],
          targetTeamId: BILLING_TEAM,
        })),
        messageBody: 'unrelated',
      });

      await engine.routeTicket(TRIGGER);

      expect(written.read.filter((table) => table === 'message')).toHaveLength(1);
    });
  });
});
