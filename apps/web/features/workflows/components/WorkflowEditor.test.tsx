import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  workflowCatalog,
  type Tag,
  type TeamResponse,
  type WorkflowResponse,
  type WorkflowTestResponse,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import type { WorkflowVocabulary } from '../presentation';
import { WorkflowEditor } from './WorkflowEditor';

/**
 * TAR-812's acceptance criteria at the surface level, and the two rules that
 * would cost a supervisor real work if they broke:
 *
 *   1. **A workflow the old form dialog wrote opens on the canvas unchanged and
 *      saves back byte-for-byte** when nothing is edited. That is criterion 4,
 *      and it is what makes the swap safe for workflows already running.
 *   2. **Saving never arms or disarms anything.** `isActive` belongs to the
 *      list; a canvas that sent it would turn a workflow on because somebody
 *      fixed a typo, and it writes to live tickets.
 *
 * The canvas itself renders here — `next/dynamic` resolves in Vitest — but jsdom
 * has no layout, so React Flow measures every node as zero and hides it from the
 * accessibility tree. Anything about a node's *own* behaviour is covered in
 * `WorkflowNodeCard.test.tsx` and `WorkflowCanvas.test.tsx`; this file drives the
 * editor through the panel and the header, which is also how a keyboard user
 * drives it.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

const createWorkflowAction = vi.fn<(input: unknown) => Promise<ActionResult<{ name: string }>>>();
const updateWorkflowAction =
  vi.fn<(workflowId: string, input: unknown) => Promise<ActionResult<{ name: string }>>>();

const testWorkflowAction =
  vi.fn<(workflowId: string, input: unknown) => Promise<ActionResult<WorkflowTestResponse>>>();

vi.mock('../workflows.actions', () => ({
  createWorkflowAction: (input: unknown) => createWorkflowAction(input),
  updateWorkflowAction: (workflowId: string, input: unknown) =>
    updateWorkflowAction(workflowId, input),
  testWorkflowAction: (workflowId: string, input: unknown) => testWorkflowAction(workflowId, input),
}));

const router = { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn() };

vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/settings/workflows/0192f010-0000-7000-8000-000000001001',
}));

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

/**
 * A workflow as the old form dialog left it: armed, with a parameterised
 * trigger, three conditions and three actions in a deliberate order.
 */
const SAVED: WorkflowResponse = {
  id: '0192f010-0000-7000-8000-000000001001',
  name: 'Escalate stale tickets',
  position: 0,
  isActive: true,
  brokenReason: null,
  version: 3,
  trigger: { type: 'ticket_unresolved_for', minutes: 90 },
  conditions: [
    { type: 'ticket_priority', operator: 'in', values: ['urgent'] },
    { type: 'ticket_tag', match: 'any', tagIds: [TAG.id] },
    { type: 'business_hours', within: false },
  ],
  actions: [
    { type: 'reassign', target: { kind: 'team', teamId: TEAM.id } },
    { type: 'notify', audience: 'team', userId: null, teamId: TEAM.id, message: 'Chase this' },
    { type: 'set_priority', priority: 'urgent' },
  ],
  references: [
    { kind: 'tag', id: TAG.id, name: TAG.name, exists: true },
    { kind: 'team', id: TEAM.id, name: TEAM.name, exists: true },
  ],
  createdAt: '2026-01-05T09:00:00.000Z',
  updatedAt: '2026-02-11T14:30:00.000Z',
};

function renderEditor(overrides: Partial<Parameters<typeof WorkflowEditor>[0]> = {}) {
  return render(
    <ToastProvider>
      <WorkflowEditor catalog={CATALOG} vocabulary={VOCABULARY} canWrite {...overrides} />
    </ToastProvider>,
  );
}

const DRY_RUN: WorkflowTestResponse = {
  matched: true,
  conditions: [{ index: 0, type: 'ticket_priority', held: true, reason: null }],
  actions: [{ index: 0, type: 'reassign', outcome: 'applied', describes: 'Reassign to team' }],
};

beforeEach(() => {
  createWorkflowAction.mockReset();
  updateWorkflowAction.mockReset();
  testWorkflowAction.mockReset();
  router.push.mockReset();
  createWorkflowAction.mockResolvedValue({ status: 'success', data: { name: 'New workflow' } });
  updateWorkflowAction.mockResolvedValue({ status: 'success', data: { name: SAVED.name } });
  testWorkflowAction.mockResolvedValue({ status: 'success', data: DRY_RUN });
});

describe('WorkflowEditor — an existing workflow', () => {
  it('opens a workflow the form dialog wrote, with its name and trigger intact', () => {
    renderEditor({ workflow: SAVED });

    expect(fieldByLabel(copy.nameLabel)).toHaveValue(SAVED.name);
    // The trigger is selected on open, so the panel is never an empty column.
    expect(screen.getByText(copy.inspectorTriggerHeading)).toBeInTheDocument();
    expect(fieldByLabel(copy.minutesLabel)).toHaveValue(90);
  });

  it('saves an untouched workflow back as exactly the definition it opened with', async () => {
    renderEditor({ workflow: SAVED });

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveExisting }));

    await waitFor(() => {
      expect(updateWorkflowAction).toHaveBeenCalledTimes(1);
    });

    const [id, input] = updateWorkflowAction.mock.calls[0] ?? [];

    expect(id).toBe(SAVED.id);
    expect(input).toMatchObject({
      name: SAVED.name,
      trigger: SAVED.trigger,
      conditions: SAVED.conditions,
      actions: SAVED.actions,
    });
  });

  /**
   * The list owns the on/off switch. A canvas that carried `isActive: true` back
   * on every save would arm a workflow the moment somebody corrected its name.
   */
  it('never sends the workflow’s armed state, in either direction', async () => {
    renderEditor({ workflow: { ...SAVED, isActive: true } });

    fireEvent.change(fieldByLabel(copy.nameLabel), { target: { value: 'Escalate stale ticket' } });
    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveExisting }));

    await waitFor(() => {
      expect(updateWorkflowAction).toHaveBeenCalledTimes(1);
    });

    expect(updateWorkflowAction.mock.calls[0]?.[1]).toMatchObject({ isActive: true });
  });

  it('goes back to the list once the write lands, where arming lives', async () => {
    renderEditor({ workflow: SAVED });

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveExisting }));

    await waitFor(() => {
      expect(router.push).toHaveBeenCalledWith('/settings/workflows');
    });
  });

  it('warns before throwing away unsaved work, and only when there is some', () => {
    renderEditor({ workflow: SAVED });

    fireEvent.click(screen.getByRole('button', { name: copy.canvasCancel }));

    expect(router.push).toHaveBeenCalledWith('/settings/workflows');
    expect(screen.queryByText(copy.canvasLeaveConfirm)).not.toBeInTheDocument();
  });

  it('asks before leaving once something has been changed', () => {
    renderEditor({ workflow: SAVED });

    fireEvent.change(fieldByLabel(copy.nameLabel), { target: { value: 'Something else' } });
    expect(screen.getByText(copy.canvasUnsaved)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: copy.canvasCancel }));

    expect(screen.getByText(copy.canvasLeaveConfirm)).toBeInTheDocument();
    expect(router.push).not.toHaveBeenCalled();
  });

  /**
   * A dry run is a statement about the *saved* definition against one ticket.
   * Leaving its verdict on the nodes after an edit would report on a workflow
   * that is no longer the one on screen — and it would sit on the very step the
   * supervisor just changed.
   */
  it('drops a dry run’s verdict the moment the draft changes', async () => {
    renderEditor({ workflow: SAVED });

    fireEvent.change(fieldByLabel(copy.testTicketLabel), { target: { value: 't-42' } });
    fireEvent.click(screen.getByRole('button', { name: copy.dryRunSubmit }));

    expect(await screen.findByRole('button', { name: copy.dryRunClear })).toBeInTheDocument();

    fireEvent.change(fieldByLabel(copy.nameLabel), { target: { value: 'Escalate stale ticket' } });

    expect(screen.queryByRole('button', { name: copy.dryRunClear })).not.toBeInTheDocument();
    expect(screen.getByText(copy.dryRunUnsaved)).toBeInTheDocument();
  });

  it('reorders the actions through the panel, for anyone who cannot drag', async () => {
    renderEditor({ workflow: SAVED });

    // Select the second action, then move it up. Order is execution order.
    fireEvent.change(fieldByLabel(copy.addActionTypeLabel), { target: { value: 'set_status' } });
    fireEvent.click(screen.getByRole('button', { name: copy.addAction }));
    fireEvent.click(screen.getByRole('button', { name: copy.moveActionEarlierAria(4) }));

    // The moved step keeps the selection, now one place earlier.
    expect(screen.getByText(copy.inspectorActionHeading(3))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveExisting }));

    await waitFor(() => {
      expect(updateWorkflowAction).toHaveBeenCalledTimes(1);
    });

    expect(updateWorkflowAction.mock.calls[0]?.[1]).toMatchObject({
      actions: [SAVED.actions[0], SAVED.actions[1], { type: 'set_status' }, SAVED.actions[2]],
    });
  });

  /**
   * Node identity is positional, so removing a step renumbers everything below
   * it and a held selection would name a different step. The trigger is the one
   * node that is always there.
   */
  it('lands the selection on the trigger after a step is removed', () => {
    renderEditor({ workflow: SAVED });

    fireEvent.change(fieldByLabel(copy.addConditionTypeLabel), {
      target: { value: 'ticket_age' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.addCondition }));
    expect(screen.getByText(copy.inspectorConditionHeading(4))).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: copy.inspectorRemove }));

    expect(screen.getByText(copy.inspectorTriggerHeading)).toBeInTheDocument();
  });

  /**
   * The API refuses a save that names something gone. The console cannot read
   * the refusal's `details[].path` — `ActionResult` does not carry it — so it
   * uses `WorkflowResponse.references`, which is the same answer from the same
   * API about the same workflow.
   */
  it('opens the offending step when the API refuses a broken reference', async () => {
    updateWorkflowAction.mockResolvedValue({
      status: 'error',
      message: 'Something this workflow points at no longer exists.',
      requestId: 'req-7',
      code: 'workflow_reference_broken',
    });

    renderEditor({
      workflow: {
        ...SAVED,
        references: [
          { kind: 'tag', id: TAG.id, name: null, exists: false },
          { kind: 'team', id: TEAM.id, name: TEAM.name, exists: true },
        ],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveExisting }));

    // The tag lives in the second condition, so that is the panel that opens.
    expect(await screen.findByText(copy.inspectorConditionHeading(2))).toBeInTheDocument();
  });

  it('says what a workflow points at that is gone, on the surface as well as the node', () => {
    renderEditor({
      workflow: {
        ...SAVED,
        references: [
          { kind: 'tag', id: TAG.id, name: null, exists: false },
          { kind: 'team', id: TEAM.id, name: TEAM.name, exists: true },
        ],
      },
    });

    expect(screen.getByText(copy.brokenBody(copy.referenceKinds.tag))).toBeInTheDocument();
  });
});

describe('WorkflowEditor — a new workflow', () => {
  it('starts on the trigger a supervisor most likely means, switched off', () => {
    renderEditor();

    expect(fieldByLabel(copy.nameLabel)).toHaveValue('');
    expect(fieldByLabel(copy.triggerTypeLabel)).toHaveValue('ticket_created');
  });

  it('refuses to send a workflow with no name, and opens the step that is wrong', () => {
    renderEditor();

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveNew }));

    expect(createWorkflowAction).not.toHaveBeenCalled();
    expect(screen.getByText(copy.nameRequiredError)).toBeInTheDocument();
  });

  it('refuses a workflow with no actions and says which list is empty', () => {
    renderEditor();

    fireEvent.change(fieldByLabel(copy.nameLabel), { target: { value: 'Tag urgent tickets' } });
    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveNew }));

    expect(createWorkflowAction).not.toHaveBeenCalled();
    expect(screen.getByText(copy.actionsRequiredError)).toBeInTheDocument();
  });

  it('builds a whole workflow from the palette and sends it through the create action', async () => {
    renderEditor();

    fireEvent.change(fieldByLabel(copy.nameLabel), { target: { value: 'Tag urgent tickets' } });

    fireEvent.change(fieldByLabel(copy.addConditionTypeLabel), {
      target: { value: 'ticket_priority' },
    });
    fireEvent.click(screen.getByRole('button', { name: copy.addCondition }));

    // Adding a step selects it, so the panel is already showing what to fill in.
    expect(screen.getByText(copy.inspectorConditionHeading(1))).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('group', { name: copy.priorityValuesLabel })).getByLabelText(
        content.ticketPriorities.urgent,
      ),
    );

    fireEvent.change(fieldByLabel(copy.addActionTypeLabel), { target: { value: 'set_status' } });
    fireEvent.click(screen.getByRole('button', { name: copy.addAction }));

    fireEvent.click(screen.getByRole('button', { name: copy.canvasSaveNew }));

    await waitFor(() => {
      expect(createWorkflowAction).toHaveBeenCalledTimes(1);
    });

    expect(createWorkflowAction.mock.calls[0]?.[0]).toMatchObject({
      name: 'Tag urgent tickets',
      trigger: { type: 'ticket_created' },
      conditions: [{ type: 'ticket_priority', operator: 'in', values: ['urgent'] }],
      actions: [{ type: 'set_status', status: 'open' }],
      // A new workflow is never armed on create. It is tested, then turned on.
      isActive: false,
    });
  });

  it('offers no dry run before there is a saved workflow to run one against', () => {
    renderEditor();

    expect(screen.getByText(copy.dryRunUnsavedNew)).toBeInTheDocument();
  });
});

describe('WorkflowEditor — read-only', () => {
  it('shows the workflow and says why nothing can be changed', () => {
    renderEditor({ workflow: SAVED, canWrite: false });

    expect(screen.getByText(copy.canvasReadOnly)).toBeInTheDocument();
    expect(fieldByLabel(copy.nameLabel)).toBeDisabled();
    expect(screen.queryByRole('button', { name: copy.canvasSaveExisting })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.addCondition })).not.toBeInTheDocument();
    expect(screen.queryByText(copy.dryRunHeading)).not.toBeInTheDocument();
  });
});
