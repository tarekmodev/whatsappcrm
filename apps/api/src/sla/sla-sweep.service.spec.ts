import type { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SLA_BREACHED_EVENT, type SlaBreachedEvent } from '../events/domain-events';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import type { SystemPrisma, TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import type { SlaAlertService, InsertedSlaAlert } from './sla-alert.service';
import { SlaSweepService } from './sla-sweep.service';
import type { SlaTimerService } from './sla-timer.service';
import { SLA_SWEEP_TENANT_CHUNK } from './sla.constants';

/**
 * The sweep's decisions, as behaviour rather than as SQL.
 *
 * The statements themselves are proved against a real database in
 * `sla-breach.int-spec.ts` — a conditional `UPDATE … WHERE state = 'running'` is
 * exactly the kind of thing a mock will always agree with. What this file covers
 * is what the *service* does with the answer, and every case here is one where
 * getting it wrong is silent:
 *
 *   * a claim that moved no row must alert nobody, because another replica got
 *     there first;
 *   * every due ticket is reconciled **before** the claim reads its state, or a
 *     dropped `sla.evaluate-ticket` enqueue becomes a permanent false breach
 *     (TAR-380);
 *   * one tenant's failure must not cost every other tenant their detection;
 *   * a deactivated tenant is an operator's decision, not a fault to page on;
 *   * every tenant's work happens in that tenant's own scope, or the sweep is
 *     the cross-tenant leak it exists to avoid;
 *   * a tenant's work commits in chunks, so a transaction that fails part-way
 *     through the backlog keeps what it had already committed (TAR-381) — the
 *     failure this catches is a livelock whose only symptom is one warning line
 *     per tick.
 */

const TENANT_A = '26000000-0000-7000-8000-0000000000a1';
const TENANT_B = '26000000-0000-7000-8000-0000000000b1';
const TIMER_A = '26000000-0000-7000-8000-0000000000a2';
const TIMER_B = '26000000-0000-7000-8000-0000000000b2';
const TICKET_A = '26000000-0000-7000-8000-0000000000a3';
const TICKET_B = '26000000-0000-7000-8000-0000000000b3';
const SUPERVISOR = '26000000-0000-7000-8000-0000000000a4';

interface ClaimedRow {
  id: string;
  ticketId: string;
  kind: 'first_response';
  dueAt: Date;
}

function claimedRow(id: string, ticketId: string): ClaimedRow {
  return { id, ticketId, kind: 'first_response', dueAt: new Date('2026-08-13T09:00:00.000Z') };
}

/** `count` timers for one tenant, as phase 1 would return them. */
function dueTimers(tenantId: string, count: number): { tenantId: string; id: string }[] {
  return Array.from({ length: count }, (_, index) => ({
    tenantId,
    id: `${tenantId}-timer-${index}`,
  }));
}

describe('SlaSweepService', () => {
  let due: { tenantId: string; id: string }[];
  /**
   * What the conditional UPDATE returns, per tenant scope it was run in.
   *
   * Drained rather than re-read: the service opens one transaction per chunk, so
   * each claim hands back the next chunk's worth of rows the way a real one
   * would rather than repeating the whole list.
   */
  let claimed: Map<string, ClaimedRow[]>;
  /** What the pre-claim scan returns — the tickets carrying a due timer. */
  let dueTickets: Map<string, { ticketId: string }[]>;
  /** Tenants whose chunk throws, keyed to the 1-based transaction it starts on. */
  let failingFrom: Map<string, number>;
  let chunksPerTenant: Map<string, number>;
  let deactivatedTenants: Set<string>;
  let scopes: (string | null)[];
  let ticketEvents: Record<string, unknown>[];
  /** Every statement and reconciliation, in the order phase 2 issued them. */
  let steps: string[];
  let reconcile: jest.Mock;
  let loadAlertCandidates: jest.Mock;
  let resolveRecipients: jest.Mock;
  let insertForBreach: jest.Mock;
  let emit: jest.Mock;
  /**
   * TAR-27 delta 3: every committed breach also raises a `ticket_sla_breached`
   * workflow occurrence. Captured rather than asserted here — this suite is
   * about detection and fairness — but it must not throw, because a refused
   * enqueue may never cost a tenant its breach.
   */
  let enqueueWorkflow: jest.Mock;
  let tenantContext: TenantContextService;
  let sweep: SlaSweepService;

  /**
   * `chunk` is the 1-based transaction this client belongs to, counted by
   * `$tenantTransaction` rather than by statements: a chunk now sends **two**
   * raw statements — the pre-claim scan and the claim — so counting calls would
   * inject a failure half a chunk early and silently.
   */
  function transactionClient(chunk: number) {
    return {
      // The two statements answer different questions, so the fake dispatches on
      // the statement rather than on call order — a test that depended on the
      // order would pass against an implementation that claimed first, which is
      // the bug `steps` exists to catch.
      $queryRaw: jest.fn((strings: TemplateStringsArray) => {
        const tenantId = tenantContext.requireTenantId();
        const isClaim = strings.join('?').includes('UPDATE sla_timers');

        steps.push(isClaim ? 'claim' : 'scan');

        if (chunk >= (failingFrom.get(tenantId) ?? Number.POSITIVE_INFINITY)) {
          return Promise.reject(new Error('the database is unreachable'));
        }

        return Promise.resolve(
          isClaim
            ? (claimed.get(tenantId)?.splice(0, SLA_SWEEP_TENANT_CHUNK) ?? [])
            : (dueTickets.get(tenantId) ?? []),
        );
      }),
      ticketEvent: {
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          ticketEvents.push(data);

          return Promise.resolve({ id: 'event' });
        }),
      },
      ticket: {
        findUnique: jest.fn(() => Promise.resolve({ assignedUserId: null, assignedTeamId: null })),
      },
    };
  }

  beforeEach(() => {
    due = [
      { tenantId: TENANT_A, id: TIMER_A },
      { tenantId: TENANT_B, id: TIMER_B },
    ];
    claimed = new Map([
      [TENANT_A, [claimedRow(TIMER_A, TICKET_A)]],
      [TENANT_B, [claimedRow(TIMER_B, TICKET_B)]],
    ]);
    dueTickets = new Map([
      [TENANT_A, [{ ticketId: TICKET_A }]],
      [TENANT_B, [{ ticketId: TICKET_B }]],
    ]);
    failingFrom = new Map();
    chunksPerTenant = new Map();
    deactivatedTenants = new Set();
    scopes = [];
    ticketEvents = [];
    steps = [];
    reconcile = jest.fn((_tx: unknown, _tenantId: string, ticketId: string) => {
      steps.push(`reconcile:${ticketId}`);

      return Promise.resolve({
        ticketId,
        created: 0,
        transitioned: 0,
        firstResponseStamped: false,
      });
    });
    loadAlertCandidates = jest.fn(() => Promise.resolve([{ id: SUPERVISOR, teamIds: [] }]));
    resolveRecipients = jest.fn(() => Promise.resolve([SUPERVISOR]));
    insertForBreach = jest.fn((_tx: unknown, { slaTimerId }: { slaTimerId: string }) =>
      Promise.resolve([
        { id: `alert-for-${slaTimerId}`, recipientUserId: SUPERVISOR },
      ] satisfies InsertedSlaAlert[]),
    );
    emit = jest.fn();
    enqueueWorkflow = jest.fn(() => Promise.resolve('added' as const));

    const systemPrisma = {
      $queryRaw: jest.fn(() => Promise.resolve(due)),
    } as unknown as SystemPrisma;

    const prisma = {
      $tenantTransaction: (work: (tx: unknown) => Promise<unknown>) => {
        const tenantId = tenantContext.requireTenantId();

        scopes.push(tenantId);

        if (deactivatedTenants.has(tenantId)) {
          return Promise.reject(new TenantNotActiveError(tenantId, '$tenantTransaction'));
        }

        const chunk = (chunksPerTenant.get(tenantId) ?? 0) + 1;

        chunksPerTenant.set(tenantId, chunk);

        return work(transactionClient(chunk));
      },
    } as unknown as TenantPrisma;

    tenantContext = new TenantContextService();
    sweep = new SlaSweepService(
      systemPrisma,
      prisma,
      tenantContext,
      { reconcile } as unknown as SlaTimerService,
      { loadAlertCandidates, resolveRecipients, insertForBreach } as unknown as SlaAlertService,
      { emit } as unknown as EventEmitter2,
      { enqueue: enqueueWorkflow } as unknown as QueueService,
    );
  });

  it('does nothing at all when no timer is due', async () => {
    due = [];

    await expect(sweep.sweep()).resolves.toEqual({
      due: 0,
      breached: 0,
      alerted: 0,
      skippedTenants: 0,
      failedTenants: 0,
    });
    expect(emit).not.toHaveBeenCalled();
  });

  /**
   * Phase 1 is the one cross-tenant read; phase 2 must be scoped per tenant, or
   * every write in it is an alert row that could land in the wrong tenant.
   */
  it('opens one tenant scope per tenant with due timers', async () => {
    await sweep.sweep();

    expect(scopes).toEqual([TENANT_A, TENANT_B]);
  });

  it('alerts once per breached timer and publishes only the rows it inserted', async () => {
    const report = await sweep.sweep();

    expect(report).toMatchObject({ due: 2, breached: 2, alerted: 2 });
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith(SLA_BREACHED_EVENT, {
      tenantId: TENANT_A,
      ticketId: TICKET_A,
      alertIds: [`alert-for-${TIMER_A}`],
    } satisfies SlaBreachedEvent);
  });

  /**
   * The candidate list is invariant for the whole transaction, and the recovery
   * path this service is sized for is a full chunk of breached timers inside one
   * — so resolving it per breach meant one identical query against `users` and
   * `team_members` per timer in the chunk.
   */
  it('reads the tenant’s supervisors once per transaction, not once per breach', async () => {
    claimed.set(TENANT_A, [claimedRow(TIMER_A, TICKET_A), claimedRow('timer-2', 'ticket-2')]);

    await sweep.sweep();

    // Two tenants, two transactions — and two breaches inside the first one.
    expect(loadAlertCandidates).toHaveBeenCalledTimes(2);
    expect(resolveRecipients).toHaveBeenCalledTimes(3);
  });

  /** Nothing claimed means nothing to alert, so the candidate read is not worth making. */
  it('reads no supervisors at all when the claim moved nothing', async () => {
    claimed.set(TENANT_A, []);
    claimed.set(TENANT_B, []);

    await sweep.sweep();

    expect(loadAlertCandidates).not.toHaveBeenCalled();
  });

  it('records the breach on the ticket’s event log in the same pass', async () => {
    await sweep.sweep();

    expect(ticketEvents).toContainEqual(
      expect.objectContaining({ tenantId: TENANT_A, ticketId: TICKET_A, type: 'sla_breached' }),
    );
  });

  /**
   * The load-bearing idempotency layer. Two replicas sweeping the same timer:
   * one moves the row, the other's `WHERE state = 'running'` matches nothing —
   * and a service that alerted on the ids it *asked* about rather than the rows
   * it *moved* would page a supervisor twice every 30 seconds.
   */
  it('alerts nobody for a timer another replica had already claimed', async () => {
    claimed.set(TENANT_A, []);
    claimed.set(TENANT_B, []);

    const report = await sweep.sweep();

    expect(report).toMatchObject({ due: 2, breached: 0, alerted: 0 });
    expect(insertForBreach).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(ticketEvents).toEqual([]);
  });

  /**
   * TAR-380. The claim's `state = 'running'` predicate is only meaningful if
   * something moved a met timer out of `running`, and the only thing that did
   * was a queue job `QueueService.enqueue` is allowed to drop. So the sweep
   * re-derives each due ticket itself, and it has to happen **before** the
   * claim: reconciling afterwards would still have written the breach, the
   * `sla_breached` event and the alert.
   */
  it('reconciles every due ticket before the claim reads its state', async () => {
    await sweep.sweep();

    expect(steps).toEqual([
      'scan',
      `reconcile:${TICKET_A}`,
      'claim',
      'scan',
      `reconcile:${TICKET_B}`,
      'claim',
    ]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  /**
   * The reconciliation ran inside this transaction, so a timer it moved to `met`
   * is no longer `running` when the claim looks — and a claim that moved no row
   * alerts nobody. This is the false breach an agent's dropped `agent_replied`
   * trigger used to produce, expressed at the seam the service owns.
   */
  it('raises nothing for a ticket the reconciliation settled', async () => {
    claimed.set(TENANT_A, []);
    claimed.set(TENANT_B, []);

    const report = await sweep.sweep();

    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(report).toMatchObject({ due: 2, breached: 0, alerted: 0 });
    expect(ticketEvents).toEqual([]);
    expect(insertForBreach).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  /** Nothing due in this tenant's batch any more, so there is nothing to re-derive. */
  it('reconciles nothing when the scan finds no ticket still due', async () => {
    dueTickets.set(TENANT_A, []);
    dueTickets.set(TENANT_B, []);

    await sweep.sweep();

    expect(reconcile).not.toHaveBeenCalled();
  });

  /**
   * A tenant with no active supervisor or admin. The ticket still shows overdue
   * in the queue, and the warning is what makes "nobody was told" visible rather
   * than silent.
   */
  it('writes no alert and emits nothing when the tenant has nobody to tell', async () => {
    resolveRecipients.mockResolvedValue([]);
    const warn = jest.spyOn(sweep['logger'], 'warn').mockImplementation();

    const report = await sweep.sweep();

    expect(report).toMatchObject({ breached: 2, alerted: 0 });
    expect(insertForBreach).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no active supervisor'));
  });

  /**
   * Deactivation is a state an operator created (TAR-51), not a fault. It must
   * not fail the sweep for every other tenant — and it must not page anyone.
   */
  it('skips a deactivated tenant and carries on with the rest', async () => {
    deactivatedTenants.add(TENANT_A);
    const warn = jest.spyOn(sweep['logger'], 'warn').mockImplementation();

    const report = await sweep.sweep();

    expect(report).toMatchObject({ breached: 1, alerted: 1, skippedTenants: 1, failedTenants: 0 });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(TENANT_A));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  /**
   * Quarantined rather than aborting: one tenant's database failure must not
   * cost every other tenant their detection for this tick. The next sweep
   * retries it for free, because the predicate is `due_at <= now()`.
   */
  it('quarantines a tenant whose transaction failed', async () => {
    failingFrom.set(TENANT_A, 1);
    const error = jest.spyOn(sweep['logger'], 'error').mockImplementation();

    const report = await sweep.sweep();

    expect(report).toMatchObject({ breached: 1, alerted: 1, failedTenants: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(TENANT_A));
    expect(emit).toHaveBeenCalledTimes(1);
  });

  /**
   * TAR-381, the durability half. One transaction for a tenant's whole batch
   * means a timeout rolls back every claim in it — and because an unclaimed
   * timer only gets *older*, the identical rows lead the next sweep into the
   * identical timeout. Chunking is what breaks that loop: each committed chunk
   * leaves the candidate set for good.
   */
  describe('a tenant’s work is committed in chunks', () => {
    const OVER_ONE_CHUNK = SLA_SWEEP_TENANT_CHUNK + 5;

    beforeEach(() => {
      due = dueTimers(TENANT_A, OVER_ONE_CHUNK);
      claimed = new Map([
        [TENANT_A, due.map((timer, index) => claimedRow(timer.id, `${TICKET_A}-${String(index)}`))],
      ]);
    });

    it('opens one transaction per chunk rather than one for the whole backlog', async () => {
      const report = await sweep.sweep();

      expect(scopes).toEqual([TENANT_A, TENANT_A]);
      expect(report).toMatchObject({ due: OVER_ONE_CHUNK, breached: OVER_ONE_CHUNK });
    });

    /**
     * The property the whole ticket turns on. The second chunk times out, and
     * the first chunk's breaches must still be reported — a service that lost
     * them would re-present the same rows to the next sweep for ever.
     */
    it('keeps the chunks that committed when a later one times out', async () => {
      failingFrom.set(TENANT_A, 2);
      const error = jest.spyOn(sweep['logger'], 'error').mockImplementation();

      const report = await sweep.sweep();

      expect(report).toMatchObject({
        due: OVER_ONE_CHUNK,
        breached: SLA_SWEEP_TENANT_CHUNK,
        alerted: SLA_SWEEP_TENANT_CHUNK,
        failedTenants: 1,
      });
      // Committed and therefore delivered: the emit follows the commit, so a
      // chunk that landed reaches the supervisor even though the sweep failed.
      expect(emit).toHaveBeenCalledTimes(SLA_SWEEP_TENANT_CHUNK);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(TENANT_A));
    });

    /**
     * The failure is the tenant's, not the chunk's — whatever refused the first
     * chunk refuses the next one too, and proving that costs every tenant behind
     * this one in the loop their detection for this tick.
     */
    it('abandons the rest of a tenant’s chunks once one has failed', async () => {
      failingFrom.set(TENANT_A, 1);
      jest.spyOn(sweep['logger'], 'error').mockImplementation();

      await sweep.sweep();

      expect(scopes).toEqual([TENANT_A]);
    });

    /** Counted once per tenant, not once per chunk, or the report reads as a fleet-wide outage. */
    it('counts a tenant that failed on every chunk once', async () => {
      due = [...due, ...dueTimers(TENANT_B, 1)];
      claimed.set(TENANT_B, [claimedRow(TIMER_B, TICKET_B)]);
      failingFrom.set(TENANT_A, 1);
      jest.spyOn(sweep['logger'], 'error').mockImplementation();

      const report = await sweep.sweep();

      expect(report).toMatchObject({ failedTenants: 1, breached: 1, alerted: 1 });
    });
  });

  /**
   * The row is the record and the socket is the accelerator, so the emit happens
   * after the commit — never inside the transaction, where a rollback would
   * leave a supervisor looking at an alert that does not exist.
   */
  it('emits only after the transaction has returned', async () => {
    const order: string[] = [];

    insertForBreach.mockImplementation(() => {
      order.push('insert');

      return Promise.resolve([{ id: 'alert', recipientUserId: SUPERVISOR }]);
    });
    emit.mockImplementation(() => {
      order.push('emit');

      return true;
    });

    await sweep.sweep();

    expect(order).toEqual(['insert', 'emit', 'insert', 'emit']);
  });
});
