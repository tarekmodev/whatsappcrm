import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  permissionsForRole,
  type SessionPrincipal,
  type SlaEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SLA_BREACHED_EVENT, type SlaBreachedEvent } from '../events/domain-events';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { SlaAlertService } from './sla-alert.service';
import { SlaAlertNotFoundError } from './sla.errors';
import { SlaPolicyService } from './sla-policy.service';
import { SlaSweepService } from './sla-sweep.service';
import { SlaTimerService } from './sla-timer.service';
import { SLA_SWEEP_BATCH, SLA_SWEEP_TENANT_BATCH } from './sla.constants';

/**
 * TAR-280 against a real PostgreSQL, as `whatsappcrm_app`.
 *
 * The unit specs cover the branching. This file covers the five properties 0006
 * says must be tested **because the failure they catch is silent** — every one
 * of them lives in SQL a mock would happily agree with:
 *
 *   1. two concurrent sweeps over the same due timer produce exactly one alert
 *      row per recipient and exactly one `sla_breached` ticket event;
 *   2. a reply inside the window leaves the timer `met` and raises no alert;
 *      one outside raises exactly one;
 *   3. tenant B's sweep never writes into tenant A;
 *   4. a ticket paused and resumed has its `due_at` moved forward by the length
 *      of the pause, and does not breach in between;
 *   5. a deadline long in the past is swept once when detection resumes — the
 *      Redis-outage case, where catch-up is the whole point of a sweep.
 *
 * ⚠️ Writes and commits. Two fixture tenants carrying fixed ids, deleted before
 * the run as well as after it, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '80280280-0000-7000-8000-000000000001';
const TENANT_B = '80280280-0000-7000-8000-000000000002';

const WABA_A = '80280280-0000-7000-8000-0000000000a0';
const ACCOUNT_A = '80280280-0000-7000-8000-0000000000a1';
const CONTACT_A = '80280280-0000-7000-8000-0000000000a2';
const CONVERSATION_A = '80280280-0000-7000-8000-0000000000a3';
const AGENT_A = '80280280-0000-7000-8000-0000000000a4';
const SUPERVISOR_A = '80280280-0000-7000-8000-0000000000a5';

const WABA_B = '80280280-0000-7000-8000-0000000000b0';
const ACCOUNT_B = '80280280-0000-7000-8000-0000000000b1';
const CONTACT_B = '80280280-0000-7000-8000-0000000000b2';
const CONVERSATION_B = '80280280-0000-7000-8000-0000000000b3';
const SUPERVISOR_B = '80280280-0000-7000-8000-0000000000b5';

/** The window every fixture policy carries. Sixty minutes, as `SLA_DEFAULTS` seeds. */
const WINDOW_MINUTES = 60;
const WINDOW_MS = WINDOW_MINUTES * 60_000;

describe('SLA breach detection against a real database', () => {
  const tenantContext = new TenantContextService();
  const events = new EventEmitter2();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let timers: SlaTimerService;
  let sweep: SlaSweepService;
  let alerts: SlaAlertService;
  /** Namespaces the phone numbers `seedOverdueBacklog` allocates, per call. */
  let backlogsSeeded = 0;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'tar280-int-spec', tenantId, userId: null },
      async () => await work(),
    );
  }

  /**
   * The same scope a request opens, so the alert surface is exercised through
   * the principal narrowing that protects it rather than around it.
   */
  function asPrincipal<T>(
    tenantId: string,
    userId: string,
    role: 'supervisor' | 'agent',
    work: () => Promise<T>,
  ): Promise<T> {
    const principal: SessionPrincipal = {
      userId,
      tenantId,
      email: `${userId}@tar280.invalid`,
      displayName: 'Fixture principal',
      role,
      permissions: [...permissionsForRole(role)],
      teamIds: [],
      sessionId: '80280280-0000-7000-8000-00000000f001',
      expiresAt: '2036-12-31T23:59:59.000Z',
    };

    return tenantContext.run(
      { requestId: 'tar280-int-spec', tenantId, userId, principal },
      async () => await work(),
    );
  }

  function evaluate(
    tenantId: string,
    ticketId: string,
    reason: SlaEvaluateTicketTrigger['reason'],
  ): Promise<unknown> {
    return asTenant(tenantId, () => timers.evaluate({ tenantId, ticketId, reason }));
  }

  /**
   * A ticket, opened `minutesAgo` minutes ago.
   *
   * `created_at` is what a first-response deadline is anchored to, so moving it
   * is how this suite reaches a boundary without waiting an hour. The number is
   * allocated by hand because `ticket_counters` belongs to the linker's
   * statement, not to this story.
   */
  async function openTicket(
    tenantId: string,
    contactId: string,
    conversationId: string,
    minutesAgo: number,
    overrides: { assignedUserId?: string } = {},
  ): Promise<string> {
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);
    const { _max } = await systemPrisma.ticket.aggregate({
      where: { tenantId },
      _max: { number: true },
    });

    const ticket = await systemPrisma.ticket.create({
      data: {
        tenantId,
        number: (_max.number ?? 0) + 1,
        status: 'open',
        conversationId,
        contactId,
        createdAt,
        ...overrides,
      },
      select: { id: true },
    });

    return ticket.id;
  }

  /** An agent's reply, `minutesAgo` minutes ago — what stops a first-response timer. */
  function storeAgentReply(
    tenantId: string,
    conversationId: string,
    senderUserId: string,
    minutesAgo: number,
  ): Promise<unknown> {
    return systemPrisma.message.create({
      data: {
        tenantId,
        conversationId,
        direction: 'outbound',
        status: 'sent',
        contentType: 'text',
        body: 'On it.',
        senderUserId,
        sentAt: new Date(Date.now() - minutesAgo * 60_000),
      },
      select: { id: true },
    });
  }

  /**
   * `count` overdue tickets on a tenant, each with a `running` timer, in four
   * bulk statements.
   *
   * Written directly rather than through `SlaTimerService.evaluate`, because a
   * few hundred round trips per test would dominate the run and what this
   * fixture is for is the *shape* of the backlog — many overdue timers on one
   * tenant — rather than how they came to exist.
   *
   * A contact and a conversation each, because `tickets_one_active_per_contact`
   * allows one open ticket per contact and the alternative (a pile of closed
   * tickets) would not be a backlog a supervisor could ever see.
   *
   * Rows are namespaced by `backlogsSeeded` and left behind rather than cleaned
   * up per test: the `beforeEach` already clears every ticket and timer, and the
   * contacts that remain are unreachable from the sweep, which reads
   * `sla_timers` alone.
   */
  async function seedOverdueBacklog(
    tenantId: string,
    whatsappAccountId: string,
    count: number,
    minutesAgo: number,
  ): Promise<void> {
    const run = (backlogsSeeded += 1);
    const createdAt = new Date(Date.now() - minutesAgo * 60_000);

    const [policy, { _max }] = await Promise.all([
      systemPrisma.slaPolicy.findFirstOrThrow({ where: { tenantId }, select: { id: true } }),
      systemPrisma.ticket.aggregate({ where: { tenantId }, _max: { number: true } }),
    ]);
    const firstNumber = (_max.number ?? 0) + 1;

    const contacts = await systemPrisma.contact.createManyAndReturn({
      data: Array.from({ length: count }, (_, index) => ({
        tenantId,
        phoneE164: `+1${String(run).padStart(2, '0')}${String(index).padStart(9, '0')}`,
      })),
      select: { id: true },
    });

    const conversations = await systemPrisma.conversation.createManyAndReturn({
      data: contacts.map((contact) => ({
        tenantId,
        whatsappAccountId,
        contactId: contact.id,
      })),
      select: { id: true, contactId: true },
    });

    const tickets = await systemPrisma.ticket.createManyAndReturn({
      data: conversations.map((conversation, index) => ({
        tenantId,
        number: firstNumber + index,
        status: 'open' as const,
        conversationId: conversation.id,
        contactId: conversation.contactId,
        createdAt,
      })),
      select: { id: true },
    });

    await systemPrisma.slaTimer.createMany({
      data: tickets.map((ticket) => ({
        tenantId,
        ticketId: ticket.id,
        policyId: policy.id,
        kind: 'first_response' as const,
        state: 'running' as const,
        startedAt: createdAt,
        dueAt: new Date(createdAt.getTime() + WINDOW_MS),
      })),
    });
  }

  function breachedTimerCount(tenantId: string): Promise<number> {
    return systemPrisma.slaTimer.count({ where: { tenantId, state: 'breached' } });
  }

  function timerFor(ticketId: string) {
    return systemPrisma.slaTimer.findFirstOrThrow({
      where: { ticketId, kind: 'first_response' },
      select: { id: true, state: true, dueAt: true, pausedAt: true, pausedMs: true },
    });
  }

  function alertsFor(ticketId: string) {
    return systemPrisma.slaAlert.findMany({
      where: { ticketId },
      select: { recipientUserId: true, tenantId: true, dueAt: true, kind: true },
    });
  }

  function breachEventsFor(ticketId: string): Promise<{ id: string }[]> {
    return systemPrisma.ticketEvent.findMany({
      where: { ticketId, type: 'sla_breached' },
      select: { id: true },
    });
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    const policies = new SlaPolicyService(tenantPrisma);

    alerts = new SlaAlertService(tenantPrisma, tenantContext);
    timers = new SlaTimerService(tenantPrisma, policies);
    sweep = new SlaSweepService(systemPrisma, tenantPrisma, tenantContext, alerts, events);

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar280-fixture-a', name: 'TAR-280 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar280-fixture-b', name: 'TAR-280 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar280-fixture-a-waba' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar280-fixture-b-waba' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar280-fixture-a-phone',
          displayPhoneNumber: '+10000002801',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar280-fixture-b-phone',
          displayPhoneNumber: '+10000002802',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+10000028001' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000028002' },
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
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: ACCOUNT_B,
          contactId: CONTACT_B,
        },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent-a@tar280.invalid',
          name: 'Agent A',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'supervisor-a@tar280.invalid',
          name: 'Supervisor A',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: SUPERVISOR_B,
          tenantId: TENANT_B,
          email: 'supervisor-b@tar280.invalid',
          name: 'Supervisor B',
          role: 'supervisor',
          status: 'active',
        },
      ],
    });
    // The policy `TenantProvisioningService` seeds. Written here rather than
    // through that service, because what is under test is the timer, not
    // provisioning — but with the same shape, so resolution behaves as it does
    // in production.
    await systemPrisma.slaPolicy.createMany({
      data: [TENANT_A, TENANT_B].map((tenantId) => ({
        tenantId,
        name: 'Default',
        priority: null,
        firstResponseMinutes: WINDOW_MINUTES,
        resolutionMinutes: null,
        isActive: true,
      })),
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.slaAlert.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.slaTimer.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.ticketEvent.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.message.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    events.removeAllListeners();
  });

  describe('starting a timer', () => {
    it('anchors the deadline to the ticket rather than to the job', async () => {
      const openedMinutesAgo = 10;
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, openedMinutesAgo);

      await evaluate(TENANT_A, ticketId, 'ticket_created');

      const timer = await timerFor(ticketId);
      const ticket = await systemPrisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { createdAt: true },
      });

      expect(timer.state).toBe('running');
      // Exactly the window from the ticket's own creation — a job that ran ten
      // minutes late gave the ticket no extension.
      expect(timer.dueAt.getTime()).toBe(ticket.createdAt.getTime() + WINDOW_MS);
    });

    /**
     * The trigger is at-least-once, so this runs on every redelivery. Two timers
     * for one target would each raise their own alert.
     */
    it('is idempotent across repeated evaluations', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, 10);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await evaluate(TENANT_A, ticketId, 'status_changed');

      const all = await systemPrisma.slaTimer.findMany({ where: { ticketId } });

      expect(all).toHaveLength(1);
    });

    /**
     * `resolutionMinutes` is null in the seeded policy, so only the
     * first-response timer exists at v1.
     */
    it('starts no resolution timer while the policy defines no window for one', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, 10);

      await evaluate(TENANT_A, ticketId, 'ticket_created');

      expect(
        await systemPrisma.slaTimer.findMany({ where: { ticketId, kind: 'resolution' } }),
      ).toHaveLength(0);
    });
  });

  describe('a reply, either side of the boundary', () => {
    /** 0006's test 2, the half that must not fire. */
    it('meets the timer when a person replied inside the window, and raises nothing', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 5);
      // One minute inside the window, on a ticket that is otherwise overdue —
      // so a false positive here is a real alert about a ticket that was
      // answered in time.
      await storeAgentReply(TENANT_A, CONVERSATION_A, AGENT_A, WINDOW_MINUTES + 4);

      await evaluate(TENANT_A, ticketId, 'agent_replied');
      await sweep.sweep();

      const timer = await timerFor(ticketId);

      expect(timer.state).toBe('met');
      expect(await alertsFor(ticketId)).toEqual([]);
      expect(await breachEventsFor(ticketId)).toEqual([]);
    });

    it('stamps first_response_at and appends the event exactly once', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, 30);
      await storeAgentReply(TENANT_A, CONVERSATION_A, AGENT_A, 20);

      await evaluate(TENANT_A, ticketId, 'agent_replied');
      await evaluate(TENANT_A, ticketId, 'agent_replied');

      const ticket = await systemPrisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { firstRespondedAt: true },
      });

      expect(ticket.firstRespondedAt).not.toBeNull();
      expect(
        await systemPrisma.ticketEvent.findMany({ where: { ticketId, type: 'first_response' } }),
      ).toHaveLength(1);
    });

    /**
     * A bot reply writes no `sender_user_id`, and 0006 risk 2 decides that it
     * does not stop the clock. Making that a property of the row rather than of
     * the calling code is what stops TAR-28 re-deciding it by accident.
     */
    it('does not count an outbound message with no sender as a first response', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, 30);
      await systemPrisma.message.create({
        data: {
          tenantId: TENANT_A,
          conversationId: CONVERSATION_A,
          direction: 'outbound',
          status: 'sent',
          contentType: 'text',
          body: 'A bot said this.',
          senderUserId: null,
          sentAt: new Date(),
        },
        select: { id: true },
      });

      await evaluate(TENANT_A, ticketId, 'agent_replied');

      const ticket = await systemPrisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { firstRespondedAt: true },
      });

      expect(ticket.firstRespondedAt).toBeNull();
      expect((await timerFor(ticketId)).state).toBe('running');
    });

    /** A reply that lands after the breach does not erase the supervisor's record of it. */
    it('leaves a breached timer breached when a late reply arrives', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 5);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await sweep.sweep();

      await storeAgentReply(TENANT_A, CONVERSATION_A, AGENT_A, 0);
      await evaluate(TENANT_A, ticketId, 'agent_replied');

      const ticket = await systemPrisma.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        select: { firstRespondedAt: true },
      });

      expect((await timerFor(ticketId)).state).toBe('breached');
      expect(ticket.firstRespondedAt).not.toBeNull();
    });
  });

  describe('the sweep', () => {
    /** 0006's test 2, the half that must fire — and 0006's test 5, catch-up. */
    it('breaches a ticket whose deadline has passed and alerts the supervisor once', async () => {
      const breaches: SlaBreachedEvent[] = [];
      events.on(SLA_BREACHED_EVENT, (event: SlaBreachedEvent) => breaches.push(event));

      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1, {
        assignedUserId: AGENT_A,
      });

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      const report = await sweep.sweep();

      expect(report).toMatchObject({ breached: 1, alerted: 1 });
      expect((await timerFor(ticketId)).state).toBe('breached');
      expect(await alertsFor(ticketId)).toEqual([
        expect.objectContaining({ recipientUserId: SUPERVISOR_A, tenantId: TENANT_A }),
      ]);
      expect(breaches).toHaveLength(1);
    });

    /**
     * 0006's test 1. The claim is a conditional `UPDATE … WHERE state =
     * 'running'`, so the second sweep moves no row and therefore alerts nobody.
     * Run concurrently rather than in sequence, because sequential runs would
     * also pass against a read-check-write implementation — which is exactly the
     * bug this exists to catch.
     */
    it('produces one alert and one event when two sweeps race over the same timer', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1, {
        assignedUserId: AGENT_A,
      });

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      const reports = await Promise.all([sweep.sweep(), sweep.sweep()]);

      expect(reports.reduce((total, report) => total + report.breached, 0)).toBe(1);
      expect(await alertsFor(ticketId)).toHaveLength(1);
      expect(await breachEventsFor(ticketId)).toHaveLength(1);
    });

    it('raises nothing a second time when it runs again over a breached timer', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await sweep.sweep();
      const second = await sweep.sweep();

      expect(second).toMatchObject({ due: 0, breached: 0, alerted: 0 });
      expect(await alertsFor(ticketId)).toHaveLength(1);
    });

    it('does not touch a timer whose deadline has not arrived', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES - 5);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await sweep.sweep();

      expect((await timerFor(ticketId)).state).toBe('running');
      expect(await alertsFor(ticketId)).toEqual([]);
    });

    /**
     * A deactivated tenant's timers can never be swept — phase 2 opens a
     * `$tenantTransaction` and `assert_tenant_active` raises before the claim
     * runs — so if phase 1 kept returning them they would stay `running` for
     * ever, and because they only get older they sort to the head of every
     * batch. One deactivated tenant with a full batch of overdue timers would
     * then stop detection for the whole platform.
     *
     * The `LIMIT 1` is what makes this a test of exclusion rather than of
     * ordering: with the deactivated tenant's older timer still in the result
     * set, the active tenant's would never fit in the batch.
     */
    it('leaves a deactivated tenant’s timers out of the batch entirely', async () => {
      const suspended = await openTicket(TENANT_B, CONTACT_B, CONVERSATION_B, WINDOW_MINUTES + 30);
      const active = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);

      await evaluate(TENANT_B, suspended, 'ticket_created');
      await evaluate(TENANT_A, active, 'ticket_created');

      await systemPrisma.tenant.update({
        where: { id: TENANT_B },
        data: { status: 'suspended' },
      });

      try {
        const report = await sweep.sweep();

        // The active tenant's breach is found and alerted; the deactivated
        // tenant is not even considered, so it is not reported as skipped.
        expect(report).toMatchObject({ breached: 1, alerted: 1, skippedTenants: 0 });
        expect((await timerFor(active)).state).toBe('breached');
        expect((await timerFor(suspended)).state).toBe('running');
        expect(await alertsFor(suspended)).toEqual([]);
      } finally {
        await systemPrisma.tenant.update({
          where: { id: TENANT_B },
          data: { status: 'active' },
        });
      }
    });

    /**
     * TAR-381 — the starvation the deactivated-tenant filter above does *not*
     * cover.
     *
     * Phase 1 used to be `ORDER BY due_at LIMIT 200` across every tenant. An
     * unclaimed timer only gets *older*, so any active tenant sitting on a full
     * batch of overdue work — one recovering from an outage, or one whose phase
     * 2 keeps timing out — owned the head of that sort indefinitely and **no
     * other tenant's breaches were examined at all**. The whole platform stopped
     * detecting, and said so only as counts on one log line.
     *
     * Tenant B's backlog is deliberately both larger than the batch and two
     * hours older than tenant A's single timer, which is precisely the ordering
     * that used to bury A.
     */
    it('breaches a second tenant in the same sweep as one holding more than a full batch', async () => {
      await seedOverdueBacklog(TENANT_B, ACCOUNT_B, SLA_SWEEP_BATCH + 5, WINDOW_MINUTES + 120);

      const crowdedOut = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);
      await evaluate(TENANT_A, crowdedOut, 'ticket_created');

      await sweep.sweep();

      expect((await timerFor(crowdedOut)).state).toBe('breached');
      expect(await alertsFor(crowdedOut)).toEqual([
        expect.objectContaining({ recipientUserId: SUPERVISOR_A, tenantId: TENANT_A }),
      ]);
      // Capped rather than unbounded: the big tenant takes its share of the
      // batch and leaves the rest, which is what left room for A above.
      expect(await breachedTimerCount(TENANT_B)).toBe(SLA_SWEEP_TENANT_BATCH);
    });

    /** And the backlog drains across sweeps rather than replaying the same rows. */
    it('takes the next slice of a large backlog on the following sweep', async () => {
      await seedOverdueBacklog(
        TENANT_B,
        ACCOUNT_B,
        SLA_SWEEP_TENANT_BATCH * 2,
        WINDOW_MINUTES + 120,
      );

      await sweep.sweep();
      expect(await breachedTimerCount(TENANT_B)).toBe(SLA_SWEEP_TENANT_BATCH);

      await sweep.sweep();
      expect(await breachedTimerCount(TENANT_B)).toBe(SLA_SWEEP_TENANT_BATCH * 2);
    });

    /**
     * 0006's test 3, and the property a cross-tenant phase 1 exists to put at
     * risk: the read spans tenants, every write must not.
     */
    it('never writes one tenant’s alert into another', async () => {
      const ticketA = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);
      const ticketB = await openTicket(TENANT_B, CONTACT_B, CONVERSATION_B, WINDOW_MINUTES + 1);

      await evaluate(TENANT_A, ticketA, 'ticket_created');
      await evaluate(TENANT_B, ticketB, 'ticket_created');
      await sweep.sweep();

      expect(await alertsFor(ticketA)).toEqual([
        expect.objectContaining({ recipientUserId: SUPERVISOR_A, tenantId: TENANT_A }),
      ]);
      expect(await alertsFor(ticketB)).toEqual([
        expect.objectContaining({ recipientUserId: SUPERVISOR_B, tenantId: TENANT_B }),
      ]);
    });
  });

  /** 0006's test 4. */
  describe('pause and resume', () => {
    it('moves the deadline forward by the length of the pause, and does not breach in between', async () => {
      const pauseMinutes = 45;
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, 30);

      await evaluate(TENANT_A, ticketId, 'ticket_created');

      await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'pending' } });
      await evaluate(TENANT_A, ticketId, 'status_changed');

      const paused = await timerFor(ticketId);

      expect(paused.state).toBe('paused');
      expect(paused.pausedAt).not.toBeNull();

      // A pause that started 45 minutes ago, and a deadline that has since gone
      // by. Backdating the row is how an hour-long pause is reached without
      // waiting one — and the overdue deadline is the point: a paused timer must
      // still not be swept, because `state = 'running'` is the predicate, so the
      // pause is what protects it rather than the clock.
      const pausedAt = new Date(Date.now() - pauseMinutes * 60_000);
      const overdueAt = new Date(Date.now() - 60_000);

      await systemPrisma.slaTimer.update({
        where: { id: paused.id },
        data: { pausedAt, dueAt: overdueAt },
      });
      await sweep.sweep();

      expect((await timerFor(ticketId)).state).toBe('paused');
      expect(await alertsFor(ticketId)).toEqual([]);

      await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'open' } });
      await evaluate(TENANT_A, ticketId, 'customer_replied');

      const resumed = await timerFor(ticketId);

      expect(resumed.state).toBe('running');
      expect(resumed.pausedAt).toBeNull();
      // Moved forward by exactly however long the pause lasted, so the agent is
      // charged for their own time and nobody else's — and the deadline is back
      // in the future, which is what stops the next sweep alerting on it.
      expect(resumed.dueAt.getTime() - overdueAt.getTime()).toBeCloseTo(pauseMinutes * 60_000, -4);
      expect(resumed.dueAt.getTime()).toBeGreaterThan(Date.now());
      expect(resumed.pausedMs).toBeCloseTo(pauseMinutes * 60_000, -4);

      await sweep.sweep();

      expect((await timerFor(ticketId)).state).toBe('running');
      expect(await alertsFor(ticketId)).toEqual([]);
    });

    it('cancels the timer on a ticket closed without an answer, and never breaches it', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'closed' } });
      await evaluate(TENANT_A, ticketId, 'status_changed');
      await sweep.sweep();

      expect((await timerFor(ticketId)).state).toBe('cancelled');
      expect(await alertsFor(ticketId)).toEqual([]);
    });
  });

  /**
   * The read surface, exercised through the principal narrowing that protects
   * it. `GET /sla-alerts` holds no `_all` permission and does not need one:
   * every row names its recipient, and the query adds
   * `recipient_user_id = principal.userId` on top of RLS.
   */
  describe('the supervisor’s alert list', () => {
    async function breachOneTicket(): Promise<string> {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1, {
        assignedUserId: AGENT_A,
      });

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await sweep.sweep();

      return ticketId;
    }

    it('shows a supervisor the alert addressed to them', async () => {
      const ticketId = await breachOneTicket();

      const page = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(page.items).toEqual([
        expect.objectContaining({ ticketId, kind: 'first_response', assignedUserId: AGENT_A }),
      ]);
    });

    /**
     * An agent may call the endpoint and gets an empty page. That is the whole
     * of TAR-281's role scoping, enforced server-side rather than by hiding a
     * button.
     */
    it('shows an agent nothing, because no row names them', async () => {
      await breachOneTicket();

      const page = await asPrincipal(TENANT_A, AGENT_A, 'agent', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(page.items).toEqual([]);
    });

    it('never shows one tenant’s supervisor another tenant’s alert', async () => {
      await breachOneTicket();

      const page = await asPrincipal(TENANT_B, SUPERVISOR_B, 'supervisor', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(page.items).toEqual([]);
    });

    it('acknowledges once and answers the same row on a second call', async () => {
      await breachOneTicket();

      const [alert] = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }).then((page) => page.items),
      );

      if (alert === undefined) {
        throw new Error('The breach raised no alert to acknowledge.');
      }

      const first = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.acknowledge(alert.id),
      );
      const second = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.acknowledge(alert.id),
      );

      expect(first.acknowledgedAt).not.toBeNull();
      // First write wins: a second click must not move "when did you see this".
      expect(second.acknowledgedAt).toBe(first.acknowledgedAt);

      const remaining = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }),
      );

      expect(remaining.items).toEqual([]);
    });

    /**
     * 404, never 403 — 0002's rule that a 403 confirms the id exists, applied to
     * a resource whose whole point is that it was addressed to one person.
     */
    it('refuses to acknowledge somebody else’s alert as though it did not exist', async () => {
      await breachOneTicket();

      const [alert] = await asPrincipal(TENANT_A, SUPERVISOR_A, 'supervisor', () =>
        alerts.list({ limit: 25, unacknowledgedOnly: true }).then((page) => page.items),
      );

      if (alert === undefined) {
        throw new Error('The breach raised no alert to acknowledge.');
      }

      await expect(
        asPrincipal(TENANT_A, AGENT_A, 'agent', () => alerts.acknowledge(alert.id)),
      ).rejects.toThrow(SlaAlertNotFoundError);
    });
  });

  describe('a ticket closed while its clock is running', () => {
    it('cancels the timer rather than breaching it', async () => {
      const ticketId = await openTicket(TENANT_A, CONTACT_A, CONVERSATION_A, WINDOW_MINUTES + 1);

      await evaluate(TENANT_A, ticketId, 'ticket_created');
      await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'closed' } });
      await evaluate(TENANT_A, ticketId, 'status_changed');
      await sweep.sweep();

      expect((await timerFor(ticketId)).state).toBe('cancelled');
      expect(await alertsFor(ticketId)).toEqual([]);
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
