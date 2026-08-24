import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { workflowCatalog, type Tag, type TeamResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { WorkflowVocabulary } from '../presentation';
import type { WorkflowNodeId } from '../graph';
import { NO_WORKFLOW_ERRORS, type WorkflowDraft } from '../workflow-form';
import { WorkflowNodeInspector } from './WorkflowNodeInspector';

/**
 * The inspector is where the rebuild has to prove it is *shell-only*: the
 * controls behind each node are the ones the form dialog already used, and the
 * panel adds only the selection, the move controls and the removal rules.
 *
 * The rules worth pinning are the ones a canvas makes easy to break: the trigger
 * cannot be removed, the last action cannot be removed, changing a step's type
 * starts a blank of the new type rather than a half-migrated one, and a
 * read-only principal sees the step rather than a panel of live controls.
 */

const copy = content.workflows;
const CATALOG = workflowCatalog();

const TEAM: TeamResponse = {
  id: '0192f002-0000-7000-8000-000000000301',
  name: 'Escalations',
  description: null,
  memberUserIds: [],
  createdAt: '2026-07-02T10:10:00.000Z',
};

const TAG: Tag = {
  id: '0192f003-0000-7000-8000-000000000401',
  name: 'Escalated',
  color: '#B42318',
};

const VOCABULARY: WorkflowVocabulary = { teams: [TEAM], users: [], tags: [TAG] };

const DRAFT: WorkflowDraft = {
  name: 'Escalate stale tickets',
  trigger: { type: 'ticket_unresolved_for', minutes: 90 },
  conditions: [{ type: 'business_hours', within: false }],
  actions: [
    { type: 'set_status', status: 'open' },
    { type: 'set_priority', priority: 'urgent' },
  ],
  isActive: false,
};

function renderInspector(
  selectedNodeId: WorkflowNodeId | null,
  overrides: Partial<Parameters<typeof WorkflowNodeInspector>[0]> = {},
) {
  const handlers = {
    onChangeTrigger: vi.fn(),
    onChangeCondition: vi.fn(),
    onChangeAction: vi.fn(),
    onRemove: vi.fn(),
    onMoveAction: vi.fn(),
  };

  render(
    <WorkflowNodeInspector
      selectedNodeId={selectedNodeId}
      draft={DRAFT}
      catalog={CATALOG}
      vocabulary={VOCABULARY}
      errors={NO_WORKFLOW_ERRORS}
      canWrite
      {...handlers}
      {...overrides}
    />,
  );

  return handlers;
}

describe('WorkflowNodeInspector', () => {
  it('explains the empty panel rather than leaving a blank column', () => {
    renderInspector(null);

    expect(screen.getByText(copy.inspectorEmptyHeading)).toBeInTheDocument();
    expect(screen.getByText(copy.inspectorEmptyBody)).toBeInTheDocument();
  });

  it('opens the trigger’s own field, parameter and all', () => {
    renderInspector('trigger');

    expect(screen.getByText(copy.inspectorTriggerHeading)).toBeInTheDocument();
    expect(fieldByLabel(copy.triggerTypeLabel)).toHaveValue('ticket_unresolved_for');
    expect(fieldByLabel(copy.minutesLabel)).toHaveValue(90);
  });

  it('never offers to remove the trigger — every workflow has exactly one', () => {
    renderInspector('trigger');

    expect(screen.queryByRole('button', { name: copy.inspectorRemove })).not.toBeInTheDocument();
  });

  it('reuses the existing condition editors rather than reimplementing them', () => {
    renderInspector('condition:0');

    expect(screen.getByText(copy.inspectorConditionHeading(1))).toBeInTheDocument();
    expect(fieldByLabel(copy.conditionTypeLabel)).toHaveValue('business_hours');
    expect(fieldByLabel(copy.businessHoursLabel)).toBeInTheDocument();
  });

  /**
   * A status set is not a tag set. Carrying values across types would build a
   * shape the contract refuses, for a reason the supervisor cannot see.
   */
  it('starts a blank step of the new type when a step’s type changes', () => {
    const { onChangeCondition } = renderInspector('condition:0');

    fireEvent.change(fieldByLabel(copy.conditionTypeLabel), {
      target: { value: 'ticket_priority' },
    });

    expect(onChangeCondition).toHaveBeenCalledWith(0, {
      type: 'ticket_priority',
      operator: 'in',
      values: [],
    });
  });

  it('moves an action through the same call a drag makes, and stands the ends down', () => {
    const { onMoveAction } = renderInspector('action:0');

    expect(screen.getByRole('button', { name: copy.moveActionEarlierAria(1) })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: copy.moveActionLaterAria(1) }));

    expect(onMoveAction).toHaveBeenCalledWith(0, 1);
  });

  it('refuses to delete the last action into a workflow the API would reject', () => {
    renderInspector('action:0', {
      draft: { ...DRAFT, actions: [{ type: 'set_status', status: 'open' }] },
    });

    expect(screen.queryByRole('button', { name: copy.inspectorRemove })).not.toBeInTheDocument();
  });

  it('removes the step the selection names', () => {
    const { onRemove } = renderInspector('action:1');

    fireEvent.click(screen.getByRole('button', { name: copy.inspectorRemove }));

    expect(onRemove).toHaveBeenCalledWith('action:1');
  });

  it('shows a read-only principal the step, with nothing they could press', () => {
    renderInspector('action:0', { canWrite: false });

    expect(fieldByLabel(copy.actionTypeLabel)).toBeDisabled();
    expect(screen.queryByRole('button', { name: copy.inspectorRemove })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: copy.moveActionLaterAria(1) }),
    ).not.toBeInTheDocument();
  });

  /**
   * Node identity is positional, so a step removed while its panel was open
   * leaves the selection naming an index that is gone. Half a form over it would
   * be worse than none.
   */
  it('falls back to the empty panel when the selection outran the draft', () => {
    renderInspector('condition:7');

    expect(screen.getByText(copy.inspectorEmptyHeading)).toBeInTheDocument();
  });
});
