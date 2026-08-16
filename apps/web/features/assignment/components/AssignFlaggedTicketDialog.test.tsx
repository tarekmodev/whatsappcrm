import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TeamResponse, TicketResponse, UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { toFlaggedTicketRows } from '../flagged-rows';
import { AssignFlaggedTicketDialog } from './AssignFlaggedTicketDialog';

/**
 * TAR-23's "a supervisor can act on it from here". `fireEvent` rather than
 * `user-event`: the repo does not carry that package. The mock is typed against
 * the action's real signature, so a test cannot go on passing while the action it
 * stands in for changes shape.
 */
const assignFlaggedTicketAction =
  vi.fn<(ticketId: string, input: unknown) => Promise<ActionResult<{ ticketId: string }>>>();

vi.mock('../assignment.actions', () => ({
  assignFlaggedTicketAction: (ticketId: string, input: unknown) =>
    assignFlaggedTicketAction(ticketId, input),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/assignment',
}));

const TICKET_ID = '0192f00a-0000-7000-8000-000000000a01';
const AMINA_ID = '0192f001-0000-7000-8000-000000000101';
const LIANG_ID = '0192f001-0000-7000-8000-000000000104';

const TEAMS: TeamResponse[] = [];

function agent(id: string, displayName: string): UserResponse {
  return {
    id,
    email: `${displayName.split(' ')[0]?.toLowerCase() ?? 'agent'}@northwind.example`,
    displayName,
    avatarUrl: null,
    role: 'agent',
    status: 'active',
    availability: 'available',
    teamIds: [],
    occupiesSeat: true,
    lastSeenAt: null,
    security: null,
    createdAt: '2026-07-02T10:00:00.000Z',
  };
}

const USERS: UserResponse[] = [agent(AMINA_ID, 'Amina Haddad'), agent(LIANG_ID, 'Liang Wei')];

const TICKET: TicketResponse = {
  id: TICKET_ID,
  number: 1041,
  conversationId: null,
  contactId: null,
  subject: 'Refund still not showing on the card',
  status: 'open',
  priority: 'normal',
  assignedUserId: null,
  assignedTeamId: null,
  routing: {
    state: 'deferred',
    deferredReason: 'all_at_capacity',
    deferredSince: '2026-08-10T07:12:00.000Z',
  },
  sla: {
    policyId: null,
    firstResponseState: 'not_applicable',
    firstResponseDueAt: null,
    resolutionState: 'not_applicable',
    resolutionDueAt: null,
  },
  firstRespondedAt: null,
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-08-10T07:10:00.000Z',
  updatedAt: '2026-08-10T07:12:00.000Z',
};

const [ROW] = toFlaggedTicketRows([TICKET], TEAMS);

function renderDialog(users: readonly UserResponse[] = USERS, onClose = vi.fn()) {
  if (ROW === undefined) {
    throw new Error('Fixture ticket is not a flagged row.');
  }

  render(
    <ToastProvider>
      <AssignFlaggedTicketDialog row={ROW} assignableUsers={users} onClose={onClose} />
    </ToastProvider>,
  );

  return { onClose };
}

/**
 * A reason is required since TAR-32: a flagged ticket routed to a team counts
 * as held by `ticketAssignRequiresReason`, so the API refuses a reasonless
 * placement. Filled by default here so the existing cases keep testing what they
 * were written for; the requirement itself has its own case below.
 */
function typeReason(value = 'Amina has room and knows the account.'): void {
  fireEvent.change(fieldByLabel(content.assignment.assignTicketReasonLabel), {
    target: { value },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.assignment.assignTicketSubmit }));
}

describe('AssignFlaggedTicketDialog', () => {
  beforeEach(() => {
    assignFlaggedTicketAction.mockReset();
    assignFlaggedTicketAction.mockResolvedValue({
      status: 'success',
      data: { ticketId: TICKET_ID },
    });
  });

  it('assigns to the picked agent under the contract’s field names', async () => {
    renderDialog();

    fireEvent.change(fieldByLabel(content.assignment.assignTicketAgentLabel), {
      target: { value: LIANG_ID },
    });
    typeReason('Liang has room this afternoon.');
    submit();

    await waitFor(() => {
      expect(assignFlaggedTicketAction).toHaveBeenCalledWith(TICKET_ID, {
        userId: LIANG_ID,
        reason: 'Liang has room this afternoon.',
      });
    });
  });

  it('will not submit without a reason, because the API requires one here', async () => {
    renderDialog();

    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });
    expect(assignFlaggedTicketAction).not.toHaveBeenCalled();
  });

  it('names the ticket and the agent in the confirmation rather than saying "Done"', async () => {
    renderDialog();

    typeReason();
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(
          content.assignment.assignTicketSuccess(
            'Refund still not showing on the card',
            'Amina Haddad',
          ),
        ),
      ).toBeInTheDocument();
    });
  });

  it('closes only after the assignment succeeded', async () => {
    const { onClose } = renderDialog();

    typeReason();
    submit();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the dialog open and shows the refusal when the write fails', async () => {
    assignFlaggedTicketAction.mockResolvedValue({
      status: 'error',
      message: 'That user cannot take tickets.',
      requestId: 'req-1',
    });

    const { onClose } = renderDialog();

    typeReason();
    submit();

    await waitFor(() => {
      expect(screen.getByText('That user cannot take tickets.')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers every agent it was given, so an at-capacity one can still be chosen', () => {
    renderDialog();

    expect(screen.getByRole('option', { name: 'Amina Haddad' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Liang Wei' })).toBeInTheDocument();
  });

  it('explains an empty workspace instead of offering a picker with nothing in it', () => {
    renderDialog([]);

    expect(screen.getByText(content.assignment.assignTicketNoAgentsError)).toBeInTheDocument();
    expect(
      screen.queryByLabelText(content.assignment.assignTicketAgentLabel),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.assignment.assignTicketSubmit }),
    ).toBeDisabled();
  });
});
