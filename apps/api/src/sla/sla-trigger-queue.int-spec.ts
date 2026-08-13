import type { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  SLA_EVALUATE_TICKET_JOB,
  SLA_QUEUE,
  type SlaEvaluateReason,
  type SlaEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { QueueService } from '../queue/queue.service';
import { SlaAlertService } from './sla-alert.service';
import { SlaPolicyService } from './sla-policy.service';
import { SlaQueueRunner } from './sla-queue.runner';
import { SlaSweepService } from './sla-sweep.service';
import { SlaTimerService } from './sla-timer.service';

/**
 * The triggers, through the **real queue** — Redis, BullMQ and the shipped
 * `SlaQueueRunner` registration, not a direct call on `SlaTimerService`.
 *
 * ## Why this file exists
 *
 * `sla-breach.int-spec.ts` calls `evaluate` directly, and that gap let a genuine
 * blocker ship to review: the triggers carried a `jobId` keyed on
 * `(tenantId, ticketId)`, stable for the ticket's whole life. `bullmq@6.0.10`'s
 * `addStandardJob` answers `handleDuplicatedJob` whenever the job key `EXISTS`
 * — in *any* state, completed included — and `removeOnComplete` keeps the newest
 * thousand completed keys alive. So the second trigger on a ticket was dropped
 * by Redis, silently: `Queue.add` neither throws nor signals it, and
 * `detectDuplicate` is off, so the enqueue reported `added`.
 *
 * The product-visible failure was the inverse of TAR-26's second acceptance
 * criterion: a ticket answered in five minutes still breached at sixty, and a
 * supervisor was alerted about it. Every unit test passed, because each producer
 * was asserted in isolation and never twice against one ticket.
 *
 * A test that mocks the queue cannot catch that class of bug — the drop happens
 * inside Redis. So this one runs the real thing.
 *
 * ⚠️ Writes and commits, and needs Redis as well as PostgreSQL. CI's Database
 * job starts both (`pnpm db:up`).
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT = '80281281-0000-7000-8000-000000000001';
const WABA = '80281281-0000-7000-8000-0000000000a0';
const ACCOUNT = '80281281-0000-7000-8000-0000000000a1';
const CONTACT = '80281281-0000-7000-8000-0000000000a2';
const CONVERSATION = '80281281-0000-7000-8000-0000000000a3';
const AGENT = '80281281-0000-7000-8000-0000000000a4';

const WINDOW_MINUTES = 60;

/** Long enough that the repeatable sweep never fires inside a case. */
const SWEEP_INTERVAL_MS = 3_600_000;

/** How long a case waits for a worker to pick a job up before failing. */
const SETTLE_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 50;

describe('the SLA triggers, through the real queue', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let queue: QueueService;
  let runner: SlaQueueRunner;

  function enqueueTrigger(ticketId: string, reason: SlaEvaluateReason): Promise<string> {
    const trigger: SlaEvaluateTicketTrigger = { tenantId: TENANT, ticketId, reason };

    return queue.enqueue<SlaEvaluateTicketTrigger>(SLA_QUEUE, SLA_EVALUATE_TICKET_JOB, trigger, {
      // Exactly what the producers pass, minus the id they no longer set. The
      // retention is the half that made a stale key outlive its job.
      attempts: 3,
      removeOnComplete: 1_000,
      removeOnFail: 5_000,
    });
  }

  /** Polls until `condition` holds, so a case never races the worker. */
  async function settle(what: string, condition: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await condition()) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    throw new Error(`Timed out after ${SETTLE_TIMEOUT_MS}ms waiting for ${what}.`);
  }

  function timerFor(ticketId: string) {
    return systemPrisma.slaTimer.findFirst({
      where: { ticketId, kind: 'first_response' },
      select: { state: true },
    });
  }

  async function openTicket(minutesAgo: number): Promise<string> {
    const { _max } = await systemPrisma.ticket.aggregate({
      where: { tenantId: TENANT },
      _max: { number: true },
    });

    const ticket = await systemPrisma.ticket.create({
      data: {
        tenantId: TENANT,
        number: (_max.number ?? 0) + 1,
        status: 'open',
        conversationId: CONVERSATION,
        contactId: CONTACT,
        createdAt: new Date(Date.now() - minutesAgo * 60_000),
      },
      select: { id: true },
    });

    return ticket.id;
  }

  function storeAgentReply(): Promise<unknown> {
    return systemPrisma.message.create({
      data: {
        tenantId: TENANT,
        conversationId: CONVERSATION,
        direction: 'outbound',
        status: 'sent',
        contentType: 'text',
        body: 'On it.',
        senderUserId: AGENT,
        sentAt: new Date(),
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    const config = {
      get: (key: string) => (key === 'REDIS_URL' ? requireEnv('REDIS_URL') : undefined),
      getOrThrow: (key: string) =>
        key === 'SLA_SWEEP_INTERVAL_MS' ? SWEEP_INTERVAL_MS : requireEnv(key),
    } as unknown as ConfigService;

    queue = new QueueService(config, tenantContext);

    const policies = new SlaPolicyService(tenantPrisma);
    const alerts = new SlaAlertService(tenantPrisma, tenantContext);
    const timers = new SlaTimerService(tenantPrisma, policies);
    const sweep = new SlaSweepService(systemPrisma, tenantPrisma, tenantContext, alerts, events());

    // The shipped registration, so what is under test is the wiring that ships.
    runner = new SlaQueueRunner(config, queue, timers, sweep);

    await removeFixture();
    await seedFixture();
  });

  afterAll(async () => {
    // Workers first, then the fixture: a worker still draining would write into
    // rows this is about to delete.
    await queue.onApplicationShutdown();
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await systemPrisma.slaAlert.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.slaTimer.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.ticketEvent.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: TENANT } });
    await systemPrisma.message.deleteMany({ where: { tenantId: TENANT } });
  });

  /**
   * The blocker, as a test. Two triggers, one ticket, in the order a real
   * conversation produces them — and the second one has to actually run.
   *
   * With a ticket-keyed `jobId` this fails at the last assertion: the timer is
   * still `running`, `first_response_at` is null, and the ticket is on course to
   * breach despite having been answered.
   */
  it('runs a second trigger on the same ticket, so an answered ticket reaches met', async () => {
    await runner.onApplicationBootstrap();

    const ticketId = await openTicket(10);

    expect(await enqueueTrigger(ticketId, 'ticket_created')).toBe('added');
    await settle(
      'the first-response timer to be created',
      async () => (await timerFor(ticketId)) !== null,
    );
    expect((await timerFor(ticketId))?.state).toBe('running');

    await storeAgentReply();

    // The second trigger for the same ticket. This is the enqueue Redis used to
    // drop, and `enqueue` reported `added` either way — so the outcome is not
    // the assertion. What the handler *did* is.
    expect(await enqueueTrigger(ticketId, 'agent_replied')).toBe('added');
    await settle(
      'the first-response timer to be met',
      async () => (await timerFor(ticketId))?.state === 'met',
    );

    const ticket = await systemPrisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      select: { firstRespondedAt: true },
    });

    expect(ticket.firstRespondedAt).not.toBeNull();
  });

  /**
   * The same collapse, on the other pair: a paused timer that never resumes
   * because the customer's reply was dropped into the creation job's key.
   */
  it('runs a customer_replied trigger after a status_changed one on the same ticket', async () => {
    await runner.onApplicationBootstrap();

    const ticketId = await openTicket(10);

    await enqueueTrigger(ticketId, 'ticket_created');
    await settle('the timer to be created', async () => (await timerFor(ticketId)) !== null);

    await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'pending' } });
    await enqueueTrigger(ticketId, 'status_changed');
    await settle('the timer to pause', async () => (await timerFor(ticketId))?.state === 'paused');

    await systemPrisma.ticket.update({ where: { id: ticketId }, data: { status: 'open' } });
    await enqueueTrigger(ticketId, 'customer_replied');
    await settle(
      'the timer to resume',
      async () => (await timerFor(ticketId))?.state === 'running',
    );

    expect((await timerFor(ticketId))?.state).toBe('running');
  });

  function events(): EventEmitter2 {
    return new EventEmitter2();
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: TENANT } });
  }

  async function seedFixture(): Promise<void> {
    await systemPrisma.tenant.create({
      data: {
        id: TENANT,
        slug: 'tar280-queue-fixture',
        name: 'TAR-280 queue fixture',
        status: 'active',
      },
      select: { id: true },
    });
    await systemPrisma.whatsappBusinessAccount.create({
      data: { id: WABA, tenantId: TENANT, wabaId: 'tar280-queue-fixture-waba' },
      select: { id: true },
    });
    await systemPrisma.whatsappAccount.create({
      data: {
        id: ACCOUNT,
        tenantId: TENANT,
        whatsappBusinessAccountId: WABA,
        phoneNumberId: 'tar280-queue-fixture-phone',
        displayPhoneNumber: '+10000028101',
      },
      select: { id: true },
    });
    await systemPrisma.contact.create({
      data: { id: CONTACT, tenantId: TENANT, phoneE164: '+10000028102' },
      select: { id: true },
    });
    await systemPrisma.conversation.create({
      data: {
        id: CONVERSATION,
        tenantId: TENANT,
        whatsappAccountId: ACCOUNT,
        contactId: CONTACT,
      },
      select: { id: true },
    });
    await systemPrisma.user.create({
      data: {
        id: AGENT,
        tenantId: TENANT,
        email: 'agent@tar280-queue.invalid',
        name: 'Queue fixture agent',
        role: 'agent',
        status: 'active',
      },
      select: { id: true },
    });
    await systemPrisma.slaPolicy.create({
      data: {
        tenantId: TENANT,
        name: 'Default',
        priority: null,
        firstResponseMinutes: WINDOW_MINUTES,
        resolutionMinutes: null,
        isActive: true,
      },
      select: { id: true },
    });
  }
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database and Redis: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
