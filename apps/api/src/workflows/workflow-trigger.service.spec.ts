import { Logger } from '@nestjs/common';
import {
  WORKFLOW_LIMITS,
  workflowDedupeKey,
  type WorkflowDefinition,
  type WorkflowEvaluateTicketTrigger,
} from '@whatsappcrm/contracts';
import type { AuditService } from '../audit/audit.service';
import type { TenantPrisma } from '../prisma/prisma.tokens';
import type { QueueService } from '../queue/queue.service';
import type { WorkflowActionExecutor } from './workflow-action.executor';
import type { WorkflowFacts } from './workflow-facts';
import type { WorkflowFactSheetService } from './workflow-fact-sheet.service';
import { WorkflowTriggerService } from './workflow-trigger.service';
import { WorkflowTicketNotVisibleError } from './workflows.errors';

/**
 * The exactly-once mechanism and the three loop bounds, driven directly.
 *
 * 0009 names four of these as tests that must exist "because the failure they
 * catch is silent":
 *
 *   * two concurrent evaluations of the same (workflow, ticket, occurrence)
 *     produce exactly **one** run;
 *   * an elapsed workflow escalates **once**, not once per sweep;
 *   * a chain of workflow-caused triggers stops at `maxChainDepth`;
 *   * a `set_status` the transition table refuses records `transition_refused`
 *     and throws nothing.
 *
 * `WorkflowTriggerService` is a plain class with five injected collaborators and
 * no framework, which is what lets this file exercise the claim without a
 * database — the claim's *SQL* is covered by the integration suite; what is
 * covered here is that the service acts only on a claim that returned.
 */

const TENANT = '019fed83-0000-7000-8000-00000000f001';
const TICKET = '019fed83-0000-7000-8000-00000000f002';
const WORKFLOW = '019fed83-0000-7000-8000-00000000f003';
const OTHER_WORKFLOW = '019fed83-0000-7000-8000-00000000f004';
const EVENT = '019fed83-0000-7000-8000-00000000f005';

interface WorkflowRowStub {
  readonly id: string;
  readonly version: number;
  readonly definition: WorkflowDefinition;
}

function elapsedDefinition(minutes: number): WorkflowDefinition {
  return {
    trigger: { type: 'ticket_unresolved_for', minutes },
    conditions: [],
    actions: [{ type: 'set_priority', priority: 'urgent' }],
  };
}

function statusDefinition(): WorkflowDefinition {
  return {
    trigger: { type: 'ticket_status_changed' },
    conditions: [],
    actions: [{ type: 'set_priority', priority: 'urgent' }],
  };
}

function trigger(
  overrides: Partial<WorkflowEvaluateTicketTrigger> = {},
): WorkflowEvaluateTicketTrigger {
  return {
    tenantId: TENANT,
    ticketId: TICKET,
    triggerType: 'ticket_status_changed',
    occurrenceId: EVENT,
    depth: 0,
    causedByRunId: null,
    ...overrides,
  };
}

function facts(overrides: Partial<WorkflowFacts> = {}): WorkflowFacts {
  return {
    status: 'open',
    priority: 'normal',
    assignedUserId: null,
    assignedTeamId: null,
    ageMinutes: 0,
    ticketTagIds: new Set<string>(),
    contactTagIds: new Set<string>(),
    withinBusinessHours: true,
    ...overrides,
  };
}

/**
 * A stand-in for the claim, keyed exactly as the unique index is:
 * `(tenant_id, workflow_id, dedupe_key)`. The first insert for a key returns an
 * id and every later one returns nothing — which is `ON CONFLICT DO NOTHING
 * RETURNING id`, and the property the whole design rests on.
 */
function claimStore(): {
  claim: jest.Mock;
  finish: jest.Mock;
  runCount: jest.Mock;
  claimedKeys: string[];
  finished: { runId: string; status: string; failureReason: string | null }[];
} {
  const held = new Set<string>();
  const claimedKeys: string[] = [];
  const finished: { runId: string; status: string; failureReason: string | null }[] = [];
  let next = 0;

  const claim = jest.fn((sql: unknown, ...values: unknown[]) => {
    // The tagged-template call arrives as (strings, ...values); the workflow id
    // and the dedupe key are the third and sixth bound values.
    const workflowId = String(values[2]);
    const dedupeKey = String(values[5]);
    const key = `${workflowId}|${dedupeKey}`;

    if (held.has(key)) {
      return Promise.resolve([]);
    }

    held.add(key);
    claimedKeys.push(key);
    next += 1;

    return Promise.resolve([{ id: `run-${next}` }]);
  });

  const finish = jest.fn(
    ({
      where,
      data,
    }: {
      where: { id: string };
      data: { status: string; failureReason: string | null };
    }) => {
      finished.push({ runId: where.id, status: data.status, failureReason: data.failureReason });

      return Promise.resolve({ count: 1 });
    },
  );

  return { claim, finish, runCount: jest.fn(() => Promise.resolve(0)), claimedKeys, finished };
}

/** One `workflow_broken` row, as `deactivate` writes it plus the column it reads back. */
interface NotificationRowStub {
  readonly tenantId: string;
  readonly type: 'workflow_broken';
  readonly ticketId: string;
  readonly recipientUserId: string;
  readonly data: { workflowId: string; workflowRunId: string };
  readonly dedupeKey: string;
  acknowledgedAt: Date | null;
}

/**
 * The notification rows `deactivate` writes, and the unique index they land
 * against.
 *
 * `UNIQUE (tenant_id, recipient_user_id, dedupe_key)` with `skipDuplicates`, so
 * a key already held inserts nothing — modelled rather than mocked away, because
 * TAR-605's bug *is* that behaviour meeting a key that outlived its occurrence.
 * `acknowledgedAt` is here for the same reason: it is what turned a duplicate
 * from harmless into invisible.
 */
function notificationStore(): {
  createMany: jest.Mock;
  insert: (data: readonly Omit<NotificationRowStub, 'acknowledgedAt'>[]) => { count: number };
  rows: NotificationRowStub[];
  acknowledgeAll: () => void;
  unacknowledged: () => string[];
} {
  const rows: NotificationRowStub[] = [];

  const insert = (
    data: readonly Omit<NotificationRowStub, 'acknowledgedAt'>[],
  ): {
    count: number;
  } => {
    let count = 0;

    for (const row of data) {
      const held = rows.some(
        (existing) =>
          existing.recipientUserId === row.recipientUserId && existing.dedupeKey === row.dedupeKey,
      );

      if (!held) {
        rows.push({ ...row, acknowledgedAt: null });
        count += 1;
      }
    }

    return { count };
  };

  return {
    createMany: jest.fn(
      ({ data }: { data: Omit<NotificationRowStub, 'acknowledgedAt'>[]; skipDuplicates: true }) =>
        Promise.resolve(insert(data)),
    ),
    insert,
    rows,
    acknowledgeAll: () => {
      for (const row of rows) {
        row.acknowledgedAt ??= new Date();
      }
    },
    // What `GET /api/v1/notifications` shows under its default
    // `unacknowledgedOnly=true` — the inbox, not the table.
    unacknowledged: () =>
      rows.filter((row) => row.acknowledgedAt === null).map((row) => row.dedupeKey),
  };
}

interface Harness {
  readonly service: WorkflowTriggerService;
  readonly store: ReturnType<typeof claimStore>;
  readonly notifications: ReturnType<typeof notificationStore>;
  readonly disarmed: string[];
  /** Switches a disarmed workflow back on, as a supervisor repairing it does. */
  readonly rearm: (workflowId: string) => boolean;
  readonly execute: jest.Mock;
  readonly enqueue: jest.Mock;
  readonly loadFacts: jest.Mock;
}

function harness(
  rows: readonly WorkflowRowStub[],
  options: {
    readonly facts?: WorkflowFacts;
    readonly factsError?: Error;
    readonly admins?: readonly string[];
  } = {},
): Harness {
  const store = claimStore();
  const notifications = notificationStore();
  const admins = options.admins ?? [];
  // Every break, in order — one entry per workflow the engine actually disarmed,
  // which is the count the notification rows are read against. `inactive` is the
  // arm state behind it, so `rearm` models the supervisor who repaired the
  // reference and switched the workflow back on.
  const disarmed: string[] = [];
  const inactive = new Set<string>();
  const execute = jest.fn(() =>
    Promise.resolve({ outcome: 'applied' as const, reason: null, occurrence: null }),
  );
  const enqueue = jest.fn(() => Promise.resolve('added' as const));
  const loadFacts = jest.fn(() =>
    options.factsError === undefined
      ? Promise.resolve(options.facts ?? facts())
      : Promise.reject(options.factsError),
  );

  const prisma = {
    workflow: {
      findMany: jest.fn(() =>
        Promise.resolve(
          rows.map((row) => ({
            id: row.id,
            version: row.version,
            definition: row.definition,
            triggerType: row.definition.trigger.type,
          })),
        ),
      ),
      updateMany: jest.fn(() => Promise.resolve({ count: 1 })),
    },
    workflowRun: { updateMany: store.finish, count: store.runCount },
    $queryRaw: store.claim,
    $tenantTransaction: (work: (tx: unknown) => Promise<unknown>) =>
      work({
        workflow: {
          // `deactivate`'s guard: only the statement that actually flipped
          // `is_active` continues, so a workflow already disarmed answers 0 and
          // writes no second incident.
          updateMany: jest.fn(({ where }: { where: { id: string } }) => {
            if (inactive.has(where.id)) {
              return Promise.resolve({ count: 0 });
            }

            inactive.add(where.id);
            disarmed.push(where.id);

            return Promise.resolve({ count: 1 });
          }),
        },
        user: { findMany: jest.fn(() => Promise.resolve(admins.map((id) => ({ id })))) },
        notification: { createMany: notifications.createMany },
      }),
  } as unknown as TenantPrisma;

  const service = new WorkflowTriggerService(
    prisma,
    { load: loadFacts } as unknown as WorkflowFactSheetService,
    { execute } as unknown as WorkflowActionExecutor,
    { enqueue } as unknown as QueueService,
    { record: jest.fn(() => Promise.resolve()) } as unknown as AuditService,
  );

  return {
    service,
    store,
    notifications,
    disarmed,
    rearm: (workflowId: string) => inactive.delete(workflowId),
    execute,
    enqueue,
    loadFacts,
  };
}

describe('the claim', () => {
  it('runs a workflow once for an occurrence and never again', async () => {
    // 0009's first must-exist test, driven as a redelivery rather than as two
    // concurrent workers: the property is the same one — only the insert that
    // returned may act.
    const { service, store, execute } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    const first = await service.evaluate(trigger());
    const second = await service.evaluate(trigger());

    expect(first.claimed).toBe(1);
    expect(second.claimed).toBe(0);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.claimedKeys).toEqual([`${WORKFLOW}|${workflowDedupeKey(trigger())}`]);
  });

  it('gives every workflow its own claim on the same occurrence', async () => {
    // The dedupe key carries no workflow id, because the unique index does:
    // `(tenant_id, workflow_id, dedupe_key)`. Two rules reacting to one status
    // change must both run — automations compose, unlike routing.
    const { service, execute } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
      { id: OTHER_WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    const report = await service.evaluate(trigger());

    expect(report.claimed).toBe(2);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reads nothing about the ticket when every claim conflicts', async () => {
    const { service, loadFacts } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    await service.evaluate(trigger());
    loadFacts.mockClear();

    await service.evaluate(trigger());

    // A redelivery is the normal case, and 0009 sizes it as costing one
    // conflicting insert and nothing else.
    expect(loadFacts).not.toHaveBeenCalled();
  });
});

describe('the elapsed trigger', () => {
  const elapsed = trigger({ triggerType: 'ticket_unresolved_for', occurrenceId: null });

  it('escalates once however many times the sweep enqueues it', async () => {
    // 0009's second must-exist test — the failure a supervisor experiences as a
    // pager. The sweep re-enqueues an overdue ticket every tick for as long as
    // it stays open; the claim is what stops the escalation repeating.
    const { service, execute } = harness(
      [{ id: WORKFLOW, version: 1, definition: elapsedDefinition(240) }],
      { facts: facts({ ageMinutes: 300 }) },
    );

    await service.evaluate(elapsed);
    await service.evaluate(elapsed);
    await service.evaluate(elapsed);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not claim for a workflow whose own threshold is not yet met', async () => {
    // The order that matters most in this service. `ticket_unresolved_for`
    // dedupes on `ticket:{id}` — once per ticket, *ever* — so a 24-hour rule
    // that claimed at hour four would record `skipped` and could never fire.
    const { service, store } = harness(
      [
        { id: WORKFLOW, version: 1, definition: elapsedDefinition(240) },
        { id: OTHER_WORKFLOW, version: 1, definition: elapsedDefinition(1_440) },
      ],
      { facts: facts({ ageMinutes: 300 }) },
    );

    const report = await service.evaluate(elapsed);

    expect(report.claimed).toBe(1);
    expect(store.claimedKeys).toEqual([`${WORKFLOW}|ticket:${TICKET}:elapsed`]);
  });

  it('lets the slower workflow claim once the ticket is old enough', async () => {
    const { service, store } = harness(
      [{ id: OTHER_WORKFLOW, version: 1, definition: elapsedDefinition(1_440) }],
      { facts: facts({ ageMinutes: 1_500 }) },
    );

    await service.evaluate(elapsed);

    expect(store.claimedKeys).toEqual([`${OTHER_WORKFLOW}|ticket:${TICKET}:elapsed`]);
  });
});

describe('loop protection', () => {
  it('drops a job past maxChainDepth without claiming anything', async () => {
    const { service, store, execute } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    const report = await service.evaluate(trigger({ depth: WORKFLOW_LIMITS.maxChainDepth + 1 }));

    expect(report.chainDepthExceeded).toBe(true);
    expect(store.claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('still runs at exactly maxChainDepth, so a legitimate chain survives', async () => {
    const { service, execute } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    const report = await service.evaluate(trigger({ depth: WORKFLOW_LIMITS.maxChainDepth }));

    expect(report.chainDepthExceeded).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('fails the run rather than dropping it when an event trigger is over budget', async () => {
    // A failed run rather than a silent drop, because it is the tenant's rule
    // that is wrong and a supervisor needs to find it in the run list. Safe for
    // an event trigger because its key is per-occurrence: spending it costs that
    // one occurrence and nothing after it.
    const { service, store, execute } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    store.runCount.mockResolvedValue(WORKFLOW_LIMITS.runsPerTicketPerHour + 1);

    const report = await service.evaluate(trigger());

    expect(report.failed).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(store.finished).toEqual([
      { runId: 'run-1', status: 'failed', failureReason: 'run_budget_exceeded' },
    ]);
  });

  it('leaves an elapsed trigger unclaimed when over budget, so it is late and not lost', async () => {
    // The regression the review caught. `ticket_unresolved_for` dedupes on
    // `ticket:{id}` — once per ticket, ever — so claiming and then recording
    // `run_budget_exceeded` would spend the key permanently: a ticket that
    // happened to be busy in the hour its four-hour escalation came due would
    // never escalate, even after it went quiet. The budget is a rate limit and
    // must not become a permanent one.
    const elapsed = trigger({ triggerType: 'ticket_unresolved_for', occurrenceId: null });
    const { service, store, execute } = harness(
      [{ id: WORKFLOW, version: 1, definition: elapsedDefinition(240) }],
      { facts: facts({ ageMinutes: 300 }) },
    );

    store.runCount.mockResolvedValue(WORKFLOW_LIMITS.runsPerTicketPerHour + 1);

    const report = await service.evaluate(elapsed);

    expect(report.claimed).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    // Nothing claimed and nothing written, so the key is still free.
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.finished).toEqual([]);
  });

  it('still escalates once the ticket goes quiet, because the key was never spent', async () => {
    const elapsed = trigger({ triggerType: 'ticket_unresolved_for', occurrenceId: null });
    const { service, store, execute } = harness(
      [{ id: WORKFLOW, version: 1, definition: elapsedDefinition(240) }],
      { facts: facts({ ageMinutes: 300 }) },
    );

    store.runCount.mockResolvedValue(WORKFLOW_LIMITS.runsPerTicketPerHour + 1);
    await service.evaluate(elapsed);

    // The hour rolls over and the next sweep re-offers the same ticket.
    store.runCount.mockResolvedValue(0);
    const report = await service.evaluate(elapsed);

    expect(report.claimed).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('records a failed run for ticket_created over budget, because nothing re-offers it', async () => {
    // `ticket_created` is ticket-scoped like the elapsed trigger, so deferring it
    // looks symmetrical — and would be wrong. Nothing re-offers a missed
    // creation, so deferring trades a loss that is at least *recorded* for one
    // that is invisible. It keeps the failed run it can be seen in.
    const created = trigger({ triggerType: 'ticket_created', occurrenceId: null });
    const { service, store } = harness([
      {
        id: WORKFLOW,
        version: 1,
        definition: {
          trigger: { type: 'ticket_created' },
          conditions: [],
          actions: [{ type: 'set_priority', priority: 'urgent' }],
        },
      },
    ]);

    store.runCount.mockResolvedValue(WORKFLOW_LIMITS.runsPerTicketPerHour + 1);

    const report = await service.evaluate(created);

    expect(report.claimed).toBe(1);
    expect(store.finished).toEqual([
      { runId: 'run-1', status: 'failed', failureReason: 'run_budget_exceeded' },
    ]);
  });

  it('warns once per job when deferring, not once per candidate workflow', async () => {
    // The bound is a property of the ticket, not of any one workflow, so ten
    // armed elapsed workflows must not emit ten byte-identical lines.
    const elapsed = trigger({ triggerType: 'ticket_unresolved_for', occurrenceId: null });
    const { service, store } = harness(
      [
        { id: WORKFLOW, version: 1, definition: elapsedDefinition(240) },
        { id: OTHER_WORKFLOW, version: 1, definition: elapsedDefinition(240) },
      ],
      { facts: facts({ ageMinutes: 300 }) },
    );

    store.runCount.mockResolvedValue(WORKFLOW_LIMITS.runsPerTicketPerHour + 1);

    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    try {
      const report = await service.evaluate(elapsed);

      expect(report.claimed).toBe(0);
      expect(report.candidates).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('raises a chained trigger carrying depth + 1 and the causing run', async () => {
    const { service, execute, enqueue } = harness([
      { id: WORKFLOW, version: 1, definition: statusDefinition() },
    ]);

    execute.mockResolvedValue({
      outcome: 'applied',
      reason: null,
      occurrence: { triggerType: 'ticket_status_changed', ticketEventId: 'event-2' },
    });

    await service.evaluate(trigger({ depth: 1 }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    const [chainedCall] = enqueue.mock.calls as unknown[][];

    expect(chainedCall?.[2]).toMatchObject({
      depth: 2,
      causedByRunId: 'run-1',
      occurrenceId: 'event-2',
    });
  });
});

describe('outcomes on the run row', () => {
  it('records skipped when the conditions did not match', async () => {
    // Not `failed` — nothing went wrong — and it is the answer to "why didn't
    // my rule fire", which is the question a supervisor brings to the run list.
    const { service, store, execute } = harness([
      {
        id: WORKFLOW,
        version: 1,
        definition: {
          trigger: { type: 'ticket_status_changed' },
          conditions: [{ type: 'ticket_status', operator: 'in', values: ['closed'] }],
          actions: [{ type: 'set_priority', priority: 'urgent' }],
        },
      },
    ]);

    const report = await service.evaluate(trigger());

    expect(report.skipped).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(store.finished).toEqual([{ runId: 'run-1', status: 'skipped', failureReason: null }]);
  });

  it('records a refused transition and throws nothing', async () => {
    // 0009's seventh must-exist test. A workflow attempting to reopen a closed
    // ticket is a fact about that rule, not a fault — it must never reach the
    // failed job set that is monitored for infrastructure problems.
    const { service, store, execute } = harness([
      {
        id: WORKFLOW,
        version: 1,
        definition: {
          trigger: { type: 'ticket_status_changed' },
          conditions: [],
          actions: [{ type: 'set_status', status: 'open' }],
        },
      },
    ]);

    execute.mockResolvedValue({
      outcome: 'failed',
      reason: 'transition_refused',
      occurrence: null,
    });

    await expect(service.evaluate(trigger())).resolves.toMatchObject({ failed: 1 });
    expect(store.finished).toEqual([
      { runId: 'run-1', status: 'failed', failureReason: 'transition_refused' },
    ]);
  });

  it('closes a claimed run as ticket_gone rather than retrying the job', async () => {
    // The claim cannot be re-taken, so a retry could only ever no-op. The run
    // says what happened and the job succeeds.
    const { service, store } = harness(
      [{ id: WORKFLOW, version: 1, definition: statusDefinition() }],
      { factsError: new WorkflowTicketNotVisibleError(TICKET) },
    );

    await expect(service.evaluate(trigger())).resolves.toMatchObject({ failed: 1 });
    expect(store.finished).toEqual([
      { runId: 'run-1', status: 'failed', failureReason: 'ticket_gone' },
    ]);
  });

  it('stops the action list at the first failure and marks the rest skipped', async () => {
    // Later actions usually assume the earlier ones — "reassign to the
    // escalation team, then notify that team" — so running the notify after the
    // reassign failed tells somebody about work they did not receive.
    const { service, store, execute } = harness([
      {
        id: WORKFLOW,
        version: 1,
        definition: {
          trigger: { type: 'ticket_status_changed' },
          conditions: [],
          actions: [
            { type: 'set_priority', priority: 'urgent' },
            { type: 'set_status', status: 'open' },
          ],
        },
      },
    ]);

    execute
      .mockResolvedValueOnce({ outcome: 'failed', reason: 'internal_error', occurrence: null })
      .mockResolvedValue({ outcome: 'applied', reason: null, occurrence: null });

    await service.evaluate(trigger());

    expect(execute).toHaveBeenCalledTimes(1);
    expect(store.finished).toEqual([
      { runId: 'run-1', status: 'failed', failureReason: 'internal_error' },
    ]);
  });
});

describe('disarming a broken workflow', () => {
  const ADMIN = '019fed83-0000-7000-8000-00000000fa01';
  const OTHER_ADMIN = '019fed83-0000-7000-8000-00000000fa02';

  function referenceMissing(): Harness {
    const built = harness([{ id: WORKFLOW, version: 1, definition: statusDefinition() }], {
      admins: [ADMIN, OTHER_ADMIN],
    });

    built.execute.mockResolvedValue({
      outcome: 'failed',
      reason: 'reference_missing',
      occurrence: null,
    });

    return built;
  }

  it('tells every active admin once, keyed on the run that disarmed it', async () => {
    const { service, notifications, disarmed } = referenceMissing();

    await service.evaluate(trigger());

    const broken = {
      tenantId: TENANT,
      type: 'workflow_broken',
      ticketId: TICKET,
      data: { workflowId: WORKFLOW, workflowRunId: 'run-1' },
      dedupeKey: 'workflow-broken:run-1',
      acknowledgedAt: null,
    };

    expect(disarmed).toEqual([WORKFLOW]);
    expect(notifications.rows).toEqual([
      { ...broken, recipientUserId: ADMIN },
      { ...broken, recipientUserId: OTHER_ADMIN },
    ]);
  });

  it('raises a fresh notification when the same workflow breaks a second time', async () => {
    // TAR-605, and the reason the key moved off the workflow id. Before it did,
    // the second `createMany` collided on
    // `(tenant_id, recipient_user_id, dedupe_key)`, inserted nothing, and left
    // the admin's inbox holding only the row they had already dismissed — so a
    // live break showed up nowhere under the default `unacknowledgedOnly=true`.
    const { service, notifications, disarmed, rearm } = referenceMissing();

    await service.evaluate(trigger());

    // The admin reads it, repairs the reference and switches the workflow back
    // on. Both halves matter: acknowledging is what makes a suppressed duplicate
    // invisible rather than merely stale.
    notifications.acknowledgeAll();
    rearm(WORKFLOW);

    // A week later, on a different ticket event, it breaks again.
    await service.evaluate(trigger({ occurrenceId: `${EVENT}-later` }));

    expect(disarmed).toEqual([WORKFLOW, WORKFLOW]);
    expect(notifications.unacknowledged()).toEqual([
      'workflow-broken:run-2',
      'workflow-broken:run-2',
    ]);
  });

  it('writes nothing when somebody else disarmed it first', async () => {
    // A concurrent run, or a supervisor who saw the first failure. The `count`
    // guard is what makes it one notification per break rather than one per
    // ticket that trips over it — never the dedupe key.
    const { service, notifications, disarmed } = referenceMissing();

    await service.evaluate(trigger());
    await service.evaluate(trigger({ occurrenceId: `${EVENT}-concurrent` }));

    expect(disarmed).toEqual([WORKFLOW]);
    expect(notifications.rows).toHaveLength(2);
  });

  it('inserts nothing when one deactivation is delivered twice', async () => {
    // The key's remaining job, and the reason it is a key at all: the load-bearing
    // guarantee is the run claim, and this covers the window between that claim
    // and these inserts. Stable within a run, exactly as `notifyDedupeKey` is.
    const { service, notifications } = referenceMissing();

    await service.evaluate(trigger());

    const [written] = notifications.rows;

    if (written === undefined) {
      throw new Error('unreachable: the deactivation above writes one row per admin');
    }

    expect(notifications.insert([written])).toEqual({ count: 0 });
    expect(notifications.rows).toHaveLength(2);
  });
});
