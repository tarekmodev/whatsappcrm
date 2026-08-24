import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { WorkflowTestResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import { WorkflowDryRunBar } from './WorkflowDryRunBar';

/**
 * The one rule this control exists to keep: **it reports on the workflow the
 * server holds, not the one on screen.** A verdict shown beside an edited draft
 * would be a statement about a definition the supervisor has already changed —
 * and it would be shown on the very nodes they just edited.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */
const testWorkflowAction =
  vi.fn<(workflowId: string, input: unknown) => Promise<ActionResult<WorkflowTestResponse>>>();

vi.mock('../workflows.actions', () => ({
  testWorkflowAction: (workflowId: string, input: unknown) => testWorkflowAction(workflowId, input),
}));

const copy = content.workflows;
const WORKFLOW_ID = '0192f010-0000-7000-8000-000000001001';

const RESULT: WorkflowTestResponse = {
  matched: true,
  conditions: [{ index: 0, type: 'business_hours', held: true, reason: null }],
  actions: [{ index: 0, type: 'set_status', outcome: 'applied', describes: 'Set status to open' }],
};

function renderBar(overrides: Partial<Parameters<typeof WorkflowDryRunBar>[0]> = {}) {
  const onResult = vi.fn();

  render(
    <WorkflowDryRunBar
      workflowId={WORKFLOW_ID}
      isDirty={false}
      hasResult={false}
      onResult={onResult}
      {...overrides}
    />,
  );

  return { onResult };
}

beforeEach(() => {
  testWorkflowAction.mockReset();
  testWorkflowAction.mockResolvedValue({ status: 'success', data: RESULT });
});

describe('WorkflowDryRunBar', () => {
  it('checks the saved workflow against the ticket and hands the verdict up', async () => {
    const { onResult } = renderBar();

    fireEvent.change(fieldByLabel(copy.testTicketLabel), { target: { value: ' t-42 ' } });
    fireEvent.click(screen.getByRole('button', { name: copy.dryRunSubmit }));

    await waitFor(() => {
      expect(testWorkflowAction).toHaveBeenCalledWith(WORKFLOW_ID, { ticketId: 't-42' });
    });
    await waitFor(() => {
      expect(onResult).toHaveBeenCalledWith(RESULT);
    });
  });

  it('refuses to run against an edited draft, and says which workflow it would check', () => {
    renderBar({ isDirty: true });

    expect(screen.getByText(copy.dryRunUnsaved)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.dryRunSubmit })).toBeDisabled();
    expect(fieldByLabel(copy.testTicketLabel)).toBeDisabled();
  });

  it('tells a supervisor on the create route to save first, rather than failing silently', () => {
    renderBar({ workflowId: null });

    expect(screen.getByText(copy.dryRunUnsavedNew)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: copy.dryRunSubmit })).toBeDisabled();
  });

  it('does not send an empty ticket id to the API to find out it is empty', () => {
    renderBar();

    fireEvent.click(screen.getByRole('button', { name: copy.dryRunSubmit }));

    expect(testWorkflowAction).not.toHaveBeenCalled();
    expect(screen.getByText(copy.testTicketRequiredError)).toBeInTheDocument();
  });

  /**
   * The previous verdict belongs to the previous ticket. Leaving it on the nodes
   * beside a new id would read as this ticket's answer.
   */
  it('clears the verdict on the nodes before checking a second ticket', () => {
    const { onResult } = renderBar({ hasResult: true });

    fireEvent.change(fieldByLabel(copy.testTicketLabel), { target: { value: 't-43' } });
    fireEvent.click(screen.getByRole('button', { name: copy.dryRunSubmit }));

    expect(onResult).toHaveBeenCalledWith(null);
  });

  it('offers to clear a verdict only once there is one to clear', () => {
    const { onResult } = renderBar({ hasResult: true });

    fireEvent.click(screen.getByRole('button', { name: copy.dryRunClear }));

    expect(onResult).toHaveBeenCalledWith(null);
  });

  it('shows a refusal as a message rather than throwing the canvas away', async () => {
    testWorkflowAction.mockResolvedValue({
      status: 'error',
      message: 'That ticket is gone.',
      requestId: 'req-9',
    });

    renderBar();
    fireEvent.change(fieldByLabel(copy.testTicketLabel), { target: { value: 't-99' } });
    fireEvent.click(screen.getByRole('button', { name: copy.dryRunSubmit }));

    expect(await screen.findByText('That ticket is gone.')).toBeInTheDocument();
  });
});
