import { describe, expect, it } from 'vitest';
import { workflowCatalog, type Tag, type TeamResponse } from '@whatsappcrm/contracts';
import {
  availableActionTypes,
  availableConditionTypes,
  blankAction,
  blankTrigger,
  withAssignmentState,
  withNotifyAudience,
} from './builder';
import type { WorkflowVocabulary } from './presentation';

/**
 * The two rules a form is most likely to break: offering something the workspace
 * cannot satisfy, and leaving an id behind when the field that used it is no
 * longer on screen. Both produce a refusal the supervisor cannot see the cause
 * of, so both are pinned here.
 */

const CATALOG = workflowCatalog();

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const TAG: Tag = {
  id: '0192f00b-0000-7000-8000-000000000b03',
  name: 'Escalated',
  color: '#ea580c',
};

const FULL: WorkflowVocabulary = { teams: [TEAM], users: [], tags: [TAG] };
const BARE: WorkflowVocabulary = { teams: [], users: [], tags: [] };

describe('availableConditionTypes', () => {
  it('drops the tag conditions a workspace has nothing to match on', () => {
    const types = availableConditionTypes(CATALOG, BARE);

    expect(types).not.toContain('ticket_tag');
    expect(types).not.toContain('contact_tag');
    expect(types).toContain('ticket_status');
  });

  it('offers every published type once the workspace has tags', () => {
    expect(availableConditionTypes(CATALOG, FULL)).toHaveLength(CATALOG.conditions.length);
  });
});

describe('availableActionTypes', () => {
  it('drops the actions a workspace has nobody or nothing for', () => {
    const types = availableActionTypes(CATALOG, BARE);

    expect(types).not.toContain('add_ticket_tag');
    expect(types).not.toContain('reassign');
    // `notify` survives: the supervisors audience needs no taxonomy at all.
    expect(types).toContain('notify');
  });

  it('offers reassign once there is a team to reassign to', () => {
    expect(availableActionTypes(CATALOG, FULL)).toContain('reassign');
  });
});

describe('blankTrigger', () => {
  it('gives the elapsed trigger a starting threshold and every other one none', () => {
    expect(blankTrigger('ticket_unresolved_for')).toStrictEqual({
      type: 'ticket_unresolved_for',
      minutes: 60,
    });
    expect(blankTrigger('ticket_created')).toStrictEqual({ type: 'ticket_created' });
  });
});

describe('blankAction', () => {
  it('seeds a tag action with a tag that exists', () => {
    expect(blankAction('add_ticket_tag', FULL)).toStrictEqual({
      type: 'add_ticket_tag',
      tagId: TAG.id,
    });
  });

  it('leaves a reassign target unchosen rather than pre-picking one', () => {
    // "Reassign to a team" is not an answer to "which team", and a workflow that
    // silently acquired a target its author never picked writes to real tickets.
    expect(blankAction('reassign', FULL)).toStrictEqual({
      type: 'reassign',
      target: { kind: 'team', teamId: '' },
    });
  });
});

describe('withAssignmentState', () => {
  const CONDITION = {
    type: 'ticket_assignment',
    state: 'assigned_to_team',
    teamId: TEAM.id,
    userId: null,
  } as const;

  it('drops the team id when the state stops taking one', () => {
    expect(withAssignmentState(CONDITION, 'unassigned')).toStrictEqual({
      type: 'ticket_assignment',
      state: 'unassigned',
      teamId: null,
      userId: null,
    });
  });

  it('drops it when the state switches to the other kind of target', () => {
    expect(withAssignmentState(CONDITION, 'assigned_to_user')).toMatchObject({
      teamId: null,
      userId: null,
    });
  });
});

describe('withNotifyAudience', () => {
  const ACTION = {
    type: 'notify',
    audience: 'user',
    userId: '0192f001-0000-7000-8000-000000000102',
    teamId: null,
    message: 'Look at this',
  } as const;

  it('clears the id the previous audience carried', () => {
    expect(withNotifyAudience(ACTION, 'supervisors')).toMatchObject({
      audience: 'supervisors',
      userId: null,
      teamId: null,
    });
  });

  it('keeps the note, which belongs to the action rather than to the audience', () => {
    expect(withNotifyAudience(ACTION, 'team')).toMatchObject({ message: 'Look at this' });
  });
});
