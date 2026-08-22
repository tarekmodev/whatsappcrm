import { describe, expect, it } from 'vitest';
import type { Tag, TeamResponse, UserResponse, WorkflowReference } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import {
  createReferenceLookup,
  describeAction,
  describeBrokenReferences,
  describeCondition,
  describeTrigger,
  type WorkflowVocabulary,
} from './presentation';

/**
 * What a workflow *says* is the whole point of the list surface, so the sentence
 * each trigger, condition and action turns into is tested rather than eyeballed
 * — including the case a supervisor is most likely to hit and least likely to
 * expect: a tag deleted after the workflow was written.
 */

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000201',
  name: 'Billing',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const USER: UserResponse = {
  id: '0192f001-0000-7000-8000-000000000102',
  email: 'priya@northwind.example',
  displayName: 'Priya Raman',
  avatarUrl: null,
  role: 'supervisor',
  status: 'active',
  availability: 'available',
  teamIds: [],
  occupiesSeat: true,
  lastSeenAt: null,
  security: null,
  assignmentCapacity: null,
  createdAt: '2026-07-02T10:05:00.000Z',
};

const TAG: Tag = {
  id: '0192f00b-0000-7000-8000-000000000b03',
  name: 'Escalated',
  color: '#ea580c',
};
const GONE_ID = '0192f00b-0000-7000-8000-0000000009ff';

const VOCABULARY: WorkflowVocabulary = { teams: [TEAM], users: [USER], tags: [TAG] };
const NAMES = createReferenceLookup([], VOCABULARY);
const copy = content.workflows;

describe('describeTrigger', () => {
  it('reads the elapsed trigger back in the largest whole unit', () => {
    expect(describeTrigger({ type: 'ticket_unresolved_for', minutes: 240 }, content)).toContain(
      '4 hours',
    );
  });

  it('names an event trigger without inventing a parameter for it', () => {
    expect(describeTrigger({ type: 'ticket_created' }, content)).toBe(copy.summaryTriggerCreated);
  });
});

describe('describeCondition', () => {
  it('distinguishes `is one of` from `is not one of`', () => {
    const inside = describeCondition(
      { type: 'ticket_status', operator: 'in', values: ['open', 'pending'] },
      NAMES,
      content,
    );
    const outside = describeCondition(
      { type: 'ticket_status', operator: 'not_in', values: ['open', 'pending'] },
      NAMES,
      content,
    );

    expect(inside).not.toContain('not');
    expect(outside).toContain('not');
    expect(inside).toContain(content.ticketStatuses.open);
  });

  it('phrases a `none` tag match as a negation rather than dropping it', () => {
    // A workflow list has no first-match ordering to express a negation with, so
    // `none` has to be in the grammar — and it has to read as one.
    const none = describeCondition(
      { type: 'ticket_tag', match: 'none', tagIds: [TAG.id] },
      NAMES,
      content,
    );

    expect(none).toBe(copy.summaryTicketNotTagged(TAG.name));
  });

  it('separates a ticket tag from a contact tag, which read from different tables', () => {
    const ticket = describeCondition(
      { type: 'ticket_tag', match: 'any', tagIds: [TAG.id] },
      NAMES,
      content,
    );
    const contact = describeCondition(
      { type: 'contact_tag', match: 'any', tagIds: [TAG.id] },
      NAMES,
      content,
    );

    expect(ticket).not.toBe(contact);
  });

  it('says a referenced tag is gone rather than printing a raw uuid', () => {
    const summary = describeCondition(
      { type: 'ticket_tag', match: 'any', tagIds: [GONE_ID] },
      NAMES,
      content,
    );

    expect(summary).toContain(copy.unknownReference);
    expect(summary).not.toContain(GONE_ID);
  });

  it('reads a narrowed assignment differently from an unnarrowed one', () => {
    const anyone = describeCondition(
      { type: 'ticket_assignment', state: 'assigned_to_user', teamId: null, userId: null },
      NAMES,
      content,
    );
    const named = describeCondition(
      { type: 'ticket_assignment', state: 'assigned_to_user', teamId: null, userId: USER.id },
      NAMES,
      content,
    );

    expect(anyone).toBe(copy.summaryAssignedToAnyone);
    expect(named).toContain(USER.displayName);
  });

  it('distinguishes inside from outside business hours', () => {
    expect(describeCondition({ type: 'business_hours', within: true }, NAMES, content)).toBe(
      copy.summaryWithinHours,
    );
    expect(describeCondition({ type: 'business_hours', within: false }, NAMES, content)).toBe(
      copy.summaryOutsideHours,
    );
  });
});

describe('describeAction', () => {
  it('names the team a reassign points at', () => {
    const summary = describeAction(
      { type: 'reassign', target: { kind: 'team', teamId: TEAM.id } },
      NAMES,
      content,
    );

    expect(summary).toContain(TEAM.name);
    expect(summary).not.toContain(TEAM.id);
  });

  it('carries the supervisor’s own note into the summary, quoted', () => {
    const summary = describeAction(
      {
        type: 'notify',
        audience: 'supervisors',
        userId: null,
        teamId: null,
        message: 'Unresolved for 4 hours',
      },
      NAMES,
      content,
    );

    expect(summary).toContain('Unresolved for 4 hours');
  });

  it('reads a status change with the label the rest of the console uses', () => {
    expect(describeAction({ type: 'set_status', status: 'resolved' }, NAMES, content)).toContain(
      content.ticketStatuses.resolved,
    );
  });
});

describe('createReferenceLookup', () => {
  it('prefers the API’s live-resolved name over the vocabulary', () => {
    // The response resolves references against the tenant's current rows, so a
    // rename shows there first. A vocabulary read that raced it must not win.
    const references: WorkflowReference[] = [
      { kind: 'tag', id: TAG.id, name: 'Renamed', exists: true },
    ];

    expect(createReferenceLookup(references, VOCABULARY)('tag', TAG.id)).toBe('Renamed');
  });

  it('reports a reference the API says is gone as unresolvable', () => {
    const references: WorkflowReference[] = [
      { kind: 'user', id: USER.id, name: null, exists: false },
    ];

    expect(createReferenceLookup(references, VOCABULARY)('user', USER.id)).toBeNull();
  });
});

describe('describeBrokenReferences', () => {
  it('lists only the references that no longer resolve', () => {
    const broken = describeBrokenReferences(
      [
        { kind: 'tag', id: TAG.id, name: TAG.name, exists: true },
        { kind: 'user', id: GONE_ID, name: null, exists: false },
      ],
      content,
    );

    expect(broken).toStrictEqual([copy.referenceKinds.user]);
  });
});
