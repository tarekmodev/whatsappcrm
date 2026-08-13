import type { EventEmitter2 } from '@nestjs/event-emitter';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import { SLA_BREACHED_EVENT, type SlaBreachedEvent } from '../events/domain-events';
import { TenantNotActiveError } from '../prisma/prisma.errors';
import type { SystemPrisma, TenantPrisma } from '../prisma/prisma.tokens';
import type { SlaAlertService, InsertedSlaAlert } from './sla-alert.service';
import { SlaSweepService } from './sla-sweep.service';

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
 *   * one tenant's failure must not cost every other tenant their detection;
 *   * a deactivated tenant is an operator's decision, not a fault to page on;
 *   * every tenant's work happens in that tenant's own scope, or the sweep is
 *     the cross-tenant leak it exists to avoid.
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

describe('SlaSweepService', () => {
  let due: { tenantId: string; id: string }[];
  /** What the conditional UPDATE returns, per tenant scope it was run in. */
  let claimed: Map<string, ClaimedRow[]>;
  let failingTenants: Set<string>;
  let deactivatedTenants: Set<string>;
  let scopes: (string | null)[];
  let ticketEvents: Record<string, unknown>[];
  let resolveRecipients: jest.Mock;
  let insertForBreach: jest.Mock;
  let emit: jest.Mock;
  let tenantContext: TenantContextService;
  let sweep: SlaSweepService;

  function transactionClient() {
    return {
      $queryRaw: jest.fn(() => {
        const tenantId = tenantContext.requireTenantId();

        if (failingTenants.has(tenantId)) {
          return Promise.reject(new Error('the database is unreachable'));
        }

        return Promise.resolve(claimed.get(tenantId) ?? []);
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
    failingTenants = new Set();
    deactivatedTenants = new Set();
    scopes = [];
    ticketEvents = [];
    resolveRecipients = jest.fn(() => Promise.resolve([SUPERVISOR]));
    insertForBreach = jest.fn((_tx: unknown, { slaTimerId }: { slaTimerId: string }) =>
      Promise.resolve([
        { id: `alert-for-${slaTimerId}`, recipientUserId: SUPERVISOR },
      ] satisfies InsertedSlaAlert[]),
    );
    emit = jest.fn();

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

        return work(transactionClient());
      },
    } as unknown as TenantPrisma;

    tenantContext = new TenantContextService();
    sweep = new SlaSweepService(
      systemPrisma,
      prisma,
      tenantContext,
      { resolveRecipients, insertForBreach } as unknown as SlaAlertService,
      { emit } as unknown as EventEmitter2,
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
    failingTenants.add(TENANT_A);
    const error = jest.spyOn(sweep['logger'], 'error').mockImplementation();

    const report = await sweep.sweep();

    expect(report).toMatchObject({ breached: 1, alerted: 1, failedTenants: 1 });
    expect(error).toHaveBeenCalledWith(expect.stringContaining(TENANT_A));
    expect(emit).toHaveBeenCalledTimes(1);
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
