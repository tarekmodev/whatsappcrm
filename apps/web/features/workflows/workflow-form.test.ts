import { describe, expect, it } from 'vitest';
import type { WorkflowAction, WorkflowResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { draftFromWorkflow, validateWorkflowDraft, type WorkflowDraft } from './workflow-form';

/**
 * Validation exists so a supervisor is told what is wrong *next to the control
 * it is about*, rather than being sent on a round trip to read
 * `actions[1].userId`. These pin the per-field messages, and the one rule the
 * form must never relax: an edit cannot arm a workflow that was switched off.
 */

const TEAM_ID = '0192f002-0000-7000-8000-000000000201';
const USER_ID = '0192f001-0000-7000-8000-000000000102';
const TAG_ID = '0192f00b-0000-7000-8000-000000000b03';

const REASSIGN: WorkflowAction = { type: 'reassign', target: { kind: 'team', teamId: TEAM_ID } };

function draft(overrides: Partial<WorkflowDraft> = {}): WorkflowDraft {
  return {
    name: 'Escalate stale tickets',
    trigger: { type: 'ticket_created' },
    conditions: [],
    actions: [REASSIGN],
    isActive: false,
    ...overrides,
  };
}

const copy = content.workflows;

describe('validateWorkflowDraft', () => {
  it('accepts a workflow with no conditions, which means "every time"', () => {
    // The opposite of a routing rule, and deliberately so: a workflow with no
    // conditions cannot swallow anything, because every other workflow still runs.
    const validation = validateWorkflowDraft(draft(), content);

    expect(validation.status).toBe('valid');
  });

  it('refuses a workflow with no actions', () => {
    const validation = validateWorkflowDraft(draft({ actions: [] }), content);

    expect(validation).toMatchObject({
      status: 'invalid',
      errors: { actions: copy.actionsRequiredError },
    });
  });

  it('trims the name and refuses one that is only whitespace', () => {
    expect(validateWorkflowDraft(draft({ name: '   ' }), content)).toMatchObject({
      status: 'invalid',
      errors: { name: copy.nameRequiredError },
    });

    const trimmed = validateWorkflowDraft(draft({ name: '  Escalate  ' }), content);

    expect(trimmed.status === 'valid' && trimmed.input.name).toBe('Escalate');
  });

  it('refuses an elapsed threshold below what the sweep can promise', () => {
    const validation = validateWorkflowDraft(
      draft({ trigger: { type: 'ticket_unresolved_for', minutes: 1 } }),
      content,
    );

    expect(validation).toMatchObject({
      status: 'invalid',
      errors: { trigger: copy.minutesRangeError(5, 43_200) },
    });
  });

  it('names the condition that is incomplete, by its index', () => {
    const validation = validateWorkflowDraft(
      draft({
        conditions: [
          { type: 'business_hours', within: false },
          { type: 'ticket_status', operator: 'in', values: [] },
        ],
      }),
      content,
    );

    expect(validation).toMatchObject({
      status: 'invalid',
      errors: { byCondition: { 1: copy.statusValuesRequiredError } },
    });
  });

  it('refuses a notify action whose audience and target disagree', () => {
    const validation = validateWorkflowDraft(
      draft({
        actions: [{ type: 'notify', audience: 'user', userId: null, teamId: null, message: null }],
      }),
      content,
    );

    expect(validation).toMatchObject({
      status: 'invalid',
      errors: { byAction: { 0: copy.notifyUserRequiredError } },
    });
  });

  it('drops an all-whitespace note rather than sending one the API refuses', () => {
    const validation = validateWorkflowDraft(
      draft({
        actions: [
          { type: 'notify', audience: 'user', userId: USER_ID, teamId: null, message: '   ' },
        ],
      }),
      content,
    );

    expect(validation.status === 'valid' && validation.input.actions[0]).toMatchObject({
      message: null,
    });
  });

  it('refuses a tag action with nothing chosen', () => {
    const validation = validateWorkflowDraft(
      draft({ actions: [{ type: 'add_ticket_tag', tagId: '' }] }),
      content,
    );

    expect(validation).toMatchObject({
      status: 'invalid',
      errors: { byAction: { 0: copy.tagRequiredError } },
    });
  });

  it('accepts a complete tag action', () => {
    const validation = validateWorkflowDraft(
      draft({ actions: [{ type: 'add_ticket_tag', tagId: TAG_ID }] }),
      content,
    );

    expect(validation.status).toBe('valid');
  });
});

describe('draftFromWorkflow', () => {
  it('starts a new workflow switched off, because it writes to real tickets', () => {
    expect(draftFromWorkflow(null)).toMatchObject({ isActive: false, actions: [] });
  });

  it('carries an existing workflow’s on/off state through unchanged', () => {
    // The list owns the switch. A form that defaulted this would arm a disabled
    // workflow the moment somebody fixed a typo in its name.
    const workflow: WorkflowResponse = {
      id: '0192f010-0000-7000-8000-000000001001',
      name: 'Escalate stale tickets',
      position: 0,
      isActive: false,
      brokenReason: 'reference_removed',
      version: 2,
      trigger: { type: 'ticket_created' },
      conditions: [],
      actions: [REASSIGN],
      references: [],
      createdAt: '2026-08-12T09:00:00.000Z',
      updatedAt: '2026-08-13T11:30:00.000Z',
    };

    const submitted = validateWorkflowDraft(draftFromWorkflow(workflow), content);

    expect(submitted.status === 'valid' && submitted.input.isActive).toBe(false);
  });
});
