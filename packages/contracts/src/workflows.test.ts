import { describe, expect, it } from 'vitest';
import {
  NotifyActionSchema,
  TicketAssignmentConditionSchema,
  WORKFLOW_LIMITS,
  WorkflowCreateInputSchema,
  WorkflowEvaluateTicketTriggerSchema,
  workflowDedupeKey,
  workflowReferenceUses,
  type WorkflowEvaluateTicketTrigger,
} from './workflows';

/**
 * The parts of 0009's grammar that two independent implementations have to agree
 * about, and where disagreeing is silent.
 *
 * `workflowDedupeKey` is the load-bearing one: the sweep and the four event
 * producers all compute it, and a mismatch does not fail anything — it claims a
 * second run and escalates a ticket twice.
 */

const TENANT = '019fed83-0000-7000-8000-0000000000a1';
const TICKET = '019fed83-0000-7000-8000-0000000000a2';
const EVENT = '019fed83-0000-7000-8000-0000000000a3';
const TIMER = '019fed83-0000-7000-8000-0000000000a4';
const TAG = '019fed83-0000-7000-8000-0000000000a5';
const TEAM = '019fed83-0000-7000-8000-0000000000a6';
const USER = '019fed83-0000-7000-8000-0000000000a7';

function trigger(
  overrides: Partial<WorkflowEvaluateTicketTrigger> = {},
): WorkflowEvaluateTicketTrigger {
  return {
    tenantId: TENANT,
    ticketId: TICKET,
    triggerType: 'ticket_created',
    occurrenceId: null,
    depth: 0,
    causedByRunId: null,
    ...overrides,
  };
}

describe('workflowDedupeKey', () => {
  it('keys each ticket-scoped trigger once per ticket, under its own namespace', () => {
    // "Once per ticket, ever" — for `ticket_created` because a ticket is created
    // once, and for `ticket_unresolved_for` because the escalation must not
    // repeat on every sweep tick.
    expect(workflowDedupeKey(trigger({ triggerType: 'ticket_created' }))).toBe(
      `ticket:${TICKET}:created`,
    );
    expect(workflowDedupeKey(trigger({ triggerType: 'ticket_unresolved_for' }))).toBe(
      `ticket:${TICKET}:elapsed`,
    );
  });

  it('keeps the two ticket-scoped keys distinct, so an edited trigger is not pre-spent', () => {
    // The whole reason for the suffix. A workflow has one trigger at a time, but
    // that trigger is editable and `workflow_runs` rows outlive the edit — so a
    // rule that ran on 800 tickets as `ticket_created` and is then re-pointed at
    // `ticket_unresolved_for` would find its own earlier claims sitting on every
    // one of them, and could never fire on any of them again.
    expect(workflowDedupeKey(trigger({ triggerType: 'ticket_created' }))).not.toBe(
      workflowDedupeKey(trigger({ triggerType: 'ticket_unresolved_for' })),
    );
  });

  it('spells the elapsed key the way the sweep rebuilds it in SQL', () => {
    // `workflow-elapsed.sweep.ts` reconstructs this literal in a correlated
    // subquery, which cannot call this function. If the two drift the anti-join
    // silently stops matching and the sweep starves again — so the format is
    // pinned from this side too.
    expect(workflowDedupeKey(trigger({ triggerType: 'ticket_unresolved_for' }))).toBe(
      `ticket:${TICKET}:elapsed`,
    );
  });

  it('keys an event trigger on the ticket_events row that recorded it', () => {
    expect(
      workflowDedupeKey(trigger({ triggerType: 'ticket_status_changed', occurrenceId: EVENT })),
    ).toBe(`ticket:${TICKET}:event:${EVENT}`);
    expect(
      workflowDedupeKey(trigger({ triggerType: 'ticket_assigned', occurrenceId: EVENT })),
    ).toBe(`ticket:${TICKET}:event:${EVENT}`);
  });

  it('keys an SLA breach on the timer, so two timers on one ticket fire twice', () => {
    expect(
      workflowDedupeKey(trigger({ triggerType: 'ticket_sla_breached', occurrenceId: TIMER })),
    ).toBe(`ticket:${TICKET}:timer:${TIMER}`);
  });

  it('carries no workflow id, because the unique index does', () => {
    // `UNIQUE (tenant_id, workflow_id, dedupe_key)`. Putting the workflow in the
    // key as well would be harmless but redundant; leaving it out is what lets
    // two workflows both claim the same occurrence, which is the whole of
    // "every matching workflow runs".
    expect(workflowDedupeKey(trigger())).not.toContain('workflow');
  });
});

describe('WorkflowEvaluateTicketTriggerSchema', () => {
  it('requires occurrenceId for exactly the non-ticket-scoped triggers', () => {
    expect(
      WorkflowEvaluateTicketTriggerSchema.safeParse(
        trigger({ triggerType: 'ticket_status_changed', occurrenceId: null }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowEvaluateTicketTriggerSchema.safeParse(
        trigger({ triggerType: 'ticket_created', occurrenceId: EVENT }),
      ).success,
    ).toBe(false);
    expect(
      WorkflowEvaluateTicketTriggerSchema.safeParse(
        trigger({ triggerType: 'ticket_sla_breached', occurrenceId: TIMER }),
      ).success,
    ).toBe(true);
  });

  it('refuses a depth beyond one past the chain bound', () => {
    // One past, not at: the handler has to be able to *receive* the job it then
    // drops, so the bound is enforced by the handler and the schema only stops
    // an absurd value.
    expect(
      WorkflowEvaluateTicketTriggerSchema.safeParse(
        trigger({ depth: WORKFLOW_LIMITS.maxChainDepth + 1 }),
      ).success,
    ).toBe(true);
    expect(
      WorkflowEvaluateTicketTriggerSchema.safeParse(
        trigger({ depth: WORKFLOW_LIMITS.maxChainDepth + 2 }),
      ).success,
    ).toBe(false);
  });
});

describe('the create input', () => {
  it('defaults isActive to false, unlike an assignment rule', () => {
    // A routing rule that does nothing until it matches costs a misrouted
    // ticket; a workflow can close tickets and message supervisors. Creating one
    // and arming it are two acts.
    const parsed = WorkflowCreateInputSchema.parse({
      name: 'Escalate stale tickets',
      trigger: { type: 'ticket_unresolved_for', minutes: 240 },
      actions: [{ type: 'add_ticket_tag', tagId: TAG }],
    });

    expect(parsed.isActive).toBe(false);
    expect(parsed.conditions).toEqual([]);
  });

  it('accepts an empty condition set and refuses an empty action list', () => {
    const base = {
      name: 'Tag every new ticket',
      trigger: { type: 'ticket_created' as const },
      conditions: [],
    };

    expect(
      WorkflowCreateInputSchema.safeParse({
        ...base,
        actions: [{ type: 'add_ticket_tag', tagId: TAG }],
      }).success,
    ).toBe(true);
    // A workflow that does nothing is not a workflow.
    expect(WorkflowCreateInputSchema.safeParse({ ...base, actions: [] }).success).toBe(false);
  });

  it('refuses an elapsed threshold below the sweep can promise', () => {
    const below = {
      name: 'Too eager',
      trigger: { type: 'ticket_unresolved_for', minutes: 1 },
      actions: [{ type: 'add_ticket_tag', tagId: TAG }],
    };

    expect(WorkflowCreateInputSchema.safeParse(below).success).toBe(false);
  });
});

describe('shape refinements', () => {
  it('ties a notify audience to exactly its own target field', () => {
    expect(
      NotifyActionSchema.safeParse({ type: 'notify', audience: 'user', userId: USER }).success,
    ).toBe(true);
    // `user` with no user, and `supervisors` with one, are both incoherent.
    expect(NotifyActionSchema.safeParse({ type: 'notify', audience: 'user' }).success).toBe(false);
    expect(
      NotifyActionSchema.safeParse({ type: 'notify', audience: 'supervisors', userId: USER })
        .success,
    ).toBe(false);
  });

  it('refuses an assignment condition whose target contradicts its state', () => {
    expect(
      TicketAssignmentConditionSchema.safeParse({
        type: 'ticket_assignment',
        state: 'unassigned',
        userId: USER,
      }).success,
    ).toBe(false);
    expect(
      TicketAssignmentConditionSchema.safeParse({
        type: 'ticket_assignment',
        state: 'assigned_to_team',
        userId: USER,
      }).success,
    ).toBe(false);
  });
});

describe('workflowReferenceUses', () => {
  it('finds every taxonomy id with the path the console highlights', () => {
    // This is what the reverse index is written from and what a broken-reference
    // refusal names, so the two cannot disagree about which fields carry an id.
    expect(
      workflowReferenceUses(
        [{ type: 'ticket_tag', match: 'any', tagIds: [TAG] }],
        [
          { type: 'reassign', target: { kind: 'team', teamId: TEAM } },
          { type: 'notify', audience: 'user', userId: USER, teamId: null, message: null },
          { type: 'set_status', status: 'resolved' },
        ],
      ),
    ).toEqual([
      { kind: 'tag', id: TAG, path: 'conditions.0.tagIds' },
      { kind: 'team', id: TEAM, path: 'actions.0.target.teamId' },
      { kind: 'user', id: USER, path: 'actions.1.userId' },
    ]);
  });

  it('finds nothing in a definition that names no taxonomy', () => {
    expect(
      workflowReferenceUses(
        [{ type: 'ticket_status', operator: 'in', values: ['open'] }],
        [{ type: 'set_priority', priority: 'urgent' }],
      ),
    ).toEqual([]);
  });
});
