import type { WorkflowCondition } from '@whatsappcrm/contracts';
import { evaluateCondition, workflowMatches } from './workflow-conditions';
import type { WorkflowFacts } from './workflow-facts';

/**
 * The condition grammar as a table of cases.
 *
 * These are pure functions over a fact sheet, so this file is a readable
 * specification rather than a fixture exercise — which is the whole reason the
 * evaluator takes no database and is not a provider.
 *
 * The three rules under test throughout, all from 0009 decision 4:
 *
 *   * conditions combine with **AND**, and an empty list matches;
 *   * a condition with **no data to read is false** — never throwing, never
 *     matching, and false for *both* settings of a boolean;
 *   * `match: 'none'` exists here and does not in 0007's routing grammar,
 *     because a workflow list has no first-match ordering to express negation
 *     with.
 */

const TAG_URGENT = '019fed83-0000-7000-8000-00000000aaaa';
const TAG_VIP = '019fed83-0000-7000-8000-00000000bbbb';
const TEAM_ESCALATIONS = '019fed83-0000-7000-8000-00000000cccc';
const USER_SARA = '019fed83-0000-7000-8000-00000000dddd';

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

describe('workflowMatches', () => {
  it('matches an empty condition set, unlike a routing rule', () => {
    // "Every time this trigger fires, do this" is a legitimate automation and
    // cannot swallow anything, because every other workflow still runs. 0007
    // refuses the same shape for exactly the opposite reason.
    expect(workflowMatches([], facts())).toBe(true);
  });

  it('combines conditions with AND, so one failure is enough to skip', () => {
    const conditions: WorkflowCondition[] = [
      { type: 'ticket_status', operator: 'in', values: ['open'] },
      { type: 'ticket_priority', operator: 'in', values: ['urgent'] },
    ];

    expect(workflowMatches(conditions, facts({ status: 'open', priority: 'urgent' }))).toBe(true);
    expect(workflowMatches(conditions, facts({ status: 'open', priority: 'low' }))).toBe(false);
  });
});

describe('ticket_status and ticket_priority', () => {
  it.each([
    ['in', ['open', 'pending'], 'open', true],
    ['in', ['pending'], 'open', false],
    ['not_in', ['resolved', 'closed'], 'open', true],
    ['not_in', ['open'], 'open', false],
  ] as const)('status %s %p against %s is %p', (operator, values, status, expected) => {
    expect(
      evaluateCondition({ type: 'ticket_status', operator, values: [...values] }, facts({ status }))
        .held,
    ).toBe(expected);
  });

  it('reads priority the same way', () => {
    expect(
      evaluateCondition(
        { type: 'ticket_priority', operator: 'not_in', values: ['low'] },
        facts({ priority: 'urgent' }),
      ).held,
    ).toBe(true);
  });
});

describe('ticket_assignment', () => {
  it('is true for unassigned only when neither column is set', () => {
    const condition: WorkflowCondition = {
      type: 'ticket_assignment',
      state: 'unassigned',
      teamId: null,
      userId: null,
    };

    expect(evaluateCondition(condition, facts()).held).toBe(true);
    expect(evaluateCondition(condition, facts({ assignedUserId: USER_SARA })).held).toBe(false);
    expect(evaluateCondition(condition, facts({ assignedTeamId: TEAM_ESCALATIONS })).held).toBe(
      false,
    );
  });

  it('treats a null target as "anybody"', () => {
    expect(
      evaluateCondition(
        { type: 'ticket_assignment', state: 'assigned_to_user', teamId: null, userId: null },
        facts({ assignedUserId: USER_SARA }),
      ).held,
    ).toBe(true);
  });

  it('narrows to one named user when the condition names one', () => {
    const condition: WorkflowCondition = {
      type: 'ticket_assignment',
      state: 'assigned_to_user',
      teamId: null,
      userId: USER_SARA,
    };

    expect(evaluateCondition(condition, facts({ assignedUserId: USER_SARA })).held).toBe(true);
    expect(evaluateCondition(condition, facts({ assignedUserId: TAG_VIP })).held).toBe(false);
  });

  it('holds for both states when a ticket carries a user and a team', () => {
    // Both statements are true of the row, and a rule asking "is anybody on
    // this" must not turn false because a team is named too.
    const held = facts({ assignedUserId: USER_SARA, assignedTeamId: TEAM_ESCALATIONS });

    expect(
      evaluateCondition(
        { type: 'ticket_assignment', state: 'assigned_to_user', teamId: null, userId: null },
        held,
      ).held,
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: 'ticket_assignment', state: 'assigned_to_team', teamId: null, userId: null },
        held,
      ).held,
    ).toBe(true);
  });
});

describe('tag conditions', () => {
  it.each([
    ['any', [TAG_URGENT, TAG_VIP], [TAG_URGENT], true],
    ['any', [TAG_VIP], [TAG_URGENT], false],
    ['all', [TAG_URGENT, TAG_VIP], [TAG_URGENT], false],
    ['all', [TAG_URGENT], [TAG_URGENT, TAG_VIP], true],
    ['none', [TAG_VIP], [TAG_URGENT], true],
    ['none', [TAG_URGENT], [TAG_URGENT], false],
  ] as const)('ticket_tag %s %p over %p is %p', (match, tagIds, held, expected) => {
    expect(
      evaluateCondition(
        { type: 'ticket_tag', match, tagIds: [...tagIds] },
        facts({ ticketTagIds: new Set(held) }),
      ).held,
    ).toBe(expected);
  });

  it('reports no_contact rather than false when the ticket has no contact', () => {
    // Null is "there is no contact", which is a different fact from "the
    // contact has no tags" — and `none` is legitimately *true* of the second.
    const condition: WorkflowCondition = { type: 'contact_tag', match: 'none', tagIds: [TAG_VIP] };

    expect(evaluateCondition(condition, facts({ contactTagIds: null }))).toEqual({
      held: false,
      unreadable: 'no_contact',
    });
    expect(evaluateCondition(condition, facts({ contactTagIds: new Set() }))).toEqual({
      held: true,
      unreadable: null,
    });
  });
});

describe('ticket_age', () => {
  it('is inclusive at the bound, which is where the sweep delivers a ticket', () => {
    // The sweep's predicate is `created_at <= now() - interval`, so a ticket
    // arrives having just reached the bound and never having passed it. An
    // exclusive comparison would mean a 240-minute rule fires at 241.
    expect(
      evaluateCondition(
        { type: 'ticket_age', operator: 'gte', minutes: 240 },
        facts({ ageMinutes: 240 }),
      ).held,
    ).toBe(true);
    expect(
      evaluateCondition(
        { type: 'ticket_age', operator: 'gte', minutes: 240 },
        facts({ ageMinutes: 239 }),
      ).held,
    ).toBe(false);
    expect(
      evaluateCondition(
        { type: 'ticket_age', operator: 'lte', minutes: 60 },
        facts({ ageMinutes: 60 }),
      ).held,
    ).toBe(true);
  });
});

describe('business_hours', () => {
  it('is false both ways when the tenant configured nothing', () => {
    // The rule 0007 fixed and 0009 inherits. Treating an unconfigured tenant as
    // always open or always closed makes one of the two natural rules fire on
    // every single ticket.
    const unconfigured = facts({ withinBusinessHours: null });

    expect(evaluateCondition({ type: 'business_hours', within: true }, unconfigured)).toEqual({
      held: false,
      unreadable: 'business_hours_unconfigured',
    });
    expect(evaluateCondition({ type: 'business_hours', within: false }, unconfigured)).toEqual({
      held: false,
      unreadable: 'business_hours_unconfigured',
    });
  });

  it('compares against the answer when there is one', () => {
    expect(
      evaluateCondition(
        { type: 'business_hours', within: false },
        facts({ withinBusinessHours: false }),
      ).held,
    ).toBe(true);
  });
});
