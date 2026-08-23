import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ASSIGNMENT_POLICY, type AgentCapacity, type UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { toAgentCapacityRows } from '../capacity';
import { AgentCapacityDialog } from './AgentCapacityDialog';

/**
 * TAR-384's acceptance criteria at the control level: every state the spec lists —
 * the read view, editing, a save, a value out of range, and a refusal — and the
 * two things this control must never do, which are inventing a limit and reporting
 * a change that did not happen.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package. The
 * mock is typed against the action's real signature, so a test cannot go on
 * passing while the action it stands in for changes shape.
 */
const updateAgentCapacityAction =
  vi.fn<
    (
      userId: string,
      input: unknown,
    ) => Promise<ActionResult<{ userId: string; maxConcurrentTickets: number | null }>>
  >();

vi.mock('../assignment.actions', () => ({
  updateAgentCapacityAction: (userId: string, input: unknown) =>
    updateAgentCapacityAction(userId, input),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/assignment',
}));

const AMINA_ID = '0192f001-0000-7000-8000-000000000101';
const LIANG_ID = '0192f001-0000-7000-8000-000000000104';
const WORKSPACE_DEFAULT = ASSIGNMENT_POLICY.defaultMaxConcurrentTickets;

function agent(id: string, displayName: string, capacity: AgentCapacity): UserResponse {
  return {
    id,
    email: `${id}@northwind.example`,
    displayName,
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: null,
    security: null,
    assignmentCapacity: capacity,
    createdAt: '2026-07-02T10:00:00.000Z',
  };
}

/** Amina is at a limit of her own; Liang has room on the inherited one. */
const ROWS = toAgentCapacityRows([
  agent(AMINA_ID, 'Amina Haddad', {
    maxConcurrentTickets: 2,
    effectiveMaxConcurrentTickets: 2,
    activeTicketCount: 2,
  }),
  agent(LIANG_ID, 'Liang Wei', {
    maxConcurrentTickets: null,
    effectiveMaxConcurrentTickets: WORKSPACE_DEFAULT,
    activeTicketCount: 1,
  }),
]);

function renderDialog(onClose = vi.fn(), hasMore = false): { onClose: ReturnType<typeof vi.fn> } {
  render(
    <ToastProvider>
      <AgentCapacityDialog
        rows={ROWS}
        workspaceDefault={WORKSPACE_DEFAULT}
        hasMore={hasMore}
        onClose={onClose}
      />
    </ToastProvider>,
  );

  return { onClose };
}

function typeLimit(value: string): void {
  fireEvent.change(fieldByLabel(content.assignment.capacityLimitLabel), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.assignment.capacitySubmit }));
}

describe('AgentCapacityDialog', () => {
  beforeEach(() => {
    updateAgentCapacityAction.mockReset();
    updateAgentCapacityAction.mockResolvedValue({
      status: 'success',
      data: { userId: AMINA_ID, maxConcurrentTickets: 4 },
    });
  });

  /**
   * The default state. It opens on whoever is at their limit, because that is the
   * agent the flagged ticket is waiting on — and it shows the live load beside the
   * cap, so a supervisor can tell whether raising it will actually free anything.
   */
  it('opens on the agent who is at their limit, and says what they are holding', () => {
    renderDialog();

    expect(screen.getByText(content.assignment.capacityLoad(2, 2))).toBeInTheDocument();
    expect(screen.getByText(content.assignment.capacityAtLimit)).toBeInTheDocument();
    expect(fieldByLabel(content.assignment.capacityLimitLabel)).toHaveValue(2);
  });

  it('sends the new limit for the agent on screen', async () => {
    renderDialog();

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(updateAgentCapacityAction).toHaveBeenCalledWith(AMINA_ID, {
        maxConcurrentTickets: 4,
      });
    });
  });

  /** The success state: the toast names the agent and the number, then it closes. */
  it('confirms the change by name and number, then closes', async () => {
    const { onClose } = renderDialog();

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(content.assignment.capacitySuccess('Amina Haddad', 4)),
      ).toBeInTheDocument();
    });
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * `null` clears the override; omitting the field would leave it alone. The two
   * are distinct on the wire, and this is the only way back to the workspace
   * default from the console.
   */
  it('clears the override to the workspace default rather than sending nothing', async () => {
    updateAgentCapacityAction.mockResolvedValue({
      status: 'success',
      data: { userId: AMINA_ID, maxConcurrentTickets: null },
    });
    renderDialog();

    fireEvent.click(fieldByLabel(content.assignment.capacityUseDefaultLabel(WORKSPACE_DEFAULT)));
    submit();

    await waitFor(() => {
      expect(updateAgentCapacityAction).toHaveBeenCalledWith(AMINA_ID, {
        maxConcurrentTickets: null,
      });
    });
    expect(
      screen.getByText(
        content.assignment.capacityClearedSuccess('Amina Haddad', WORKSPACE_DEFAULT),
      ),
    ).toBeInTheDocument();
  });

  /** The validation state: caught before the round trip, and never sent. */
  it('refuses a limit outside the contract’s bounds, in the field', async () => {
    renderDialog();

    typeLimit(String(ASSIGNMENT_POLICY.maxMaxConcurrentTickets + 1));
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(
          content.assignment.capacityRangeError(
            ASSIGNMENT_POLICY.minMaxConcurrentTickets,
            ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
          ),
        ),
      ).toBeInTheDocument();
    });
    expect(updateAgentCapacityAction).not.toHaveBeenCalled();
  });

  /**
   * The permission-denied state, seen from inside the control: the API refuses,
   * and the supervisor is told why rather than watching the dialog close on a
   * change that never landed. Nothing is cleared, so a retry costs no retyping.
   */
  it('shows the API’s refusal and keeps the form when the write is not permitted', async () => {
    const { onClose } = renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'Changing an agent’s ticket limit requires the assignment_rule:write permission.',
      requestId: 'req-1',
      code: 'forbidden',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(
          'Changing an agent’s ticket limit requires the assignment_rule:write permission.',
        ),
      ).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(fieldByLabel(content.assignment.capacityLimitLabel)).toHaveValue(4);
  });

  /**
   * ADR 0008's failure-mode table: a limit below what somebody already holds takes
   * none of it away. Said before the button, because from the queue it looks like
   * the control did not work.
   */
  it('warns that a lower limit takes no ticket off the agent', () => {
    renderDialog();

    typeLimit('1');

    expect(
      screen.getByText(content.assignment.capacityBelowLoadWarning('Amina Haddad', 2)),
    ).toBeInTheDocument();
  });

  it('re-reads the form from the agent that was picked, not the one before', () => {
    renderDialog();

    fireEvent.change(fieldByLabel(content.assignment.capacityAgentLabel), {
      target: { value: LIANG_ID },
    });

    // Liang inherits, so the form switches to the workspace default rather than
    // carrying Amina's 2 across under his name.
    expect(
      screen.getByText(content.assignment.capacityLoad(1, WORKSPACE_DEFAULT)),
    ).toBeInTheDocument();
    expect(screen.getByText(content.assignment.capacityHasRoom)).toBeInTheDocument();
    expect(screen.queryByLabelText(content.assignment.capacityLimitLabel)).not.toBeInTheDocument();
  });

  it('says out loud when the picker holds only the first page of agents', () => {
    renderDialog(vi.fn(), true);

    expect(screen.getByText(content.assignment.capacityAgentHintTruncated)).toBeInTheDocument();
  });
});
