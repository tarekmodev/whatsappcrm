import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { ReassignTicketDialog } from './ReassignTicketDialog';

/**
 * TAR-32 AC1: an agent can reassign to a teammate, **a reason is required, and
 * the form cannot submit without one**. The first describe is that criterion.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 * The mock is typed against the action's real signature, so a test cannot go on
 * passing while the action it stands in for changes shape.
 */
const reassignTicketAction =
  vi.fn<
    (
      ticketId: string,
      input: unknown,
    ) => Promise<ActionResult<{ ticketId: string; assignedUserId: string | null }>>
  >();

vi.mock('../ticket-handoff.actions', () => ({
  reassignTicketAction: (ticketId: string, input: unknown) => reassignTicketAction(ticketId, input),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/tickets/0192f00a-0000-7000-8000-000000000a01',
}));

const TICKET_ID = '0192f00a-0000-7000-8000-000000000a01';
const PRIYA_ID = '0192f001-0000-7000-8000-000000000102';
const LIANG_ID = '0192f001-0000-7000-8000-000000000104';
const LABEL = 'July invoice never arrived';

function teammate(id: string, displayName: string): UserResponse {
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

const TEAMMATES: UserResponse[] = [
  teammate(PRIYA_ID, 'Priya Raman'),
  teammate(LIANG_ID, 'Liang Wei'),
];

function renderDialog(teammates: readonly UserResponse[] = TEAMMATES, onClose = vi.fn()) {
  render(
    <ToastProvider>
      <ReassignTicketDialog
        ticketId={TICKET_ID}
        label={LABEL}
        teammates={teammates}
        onClose={onClose}
      />
    </ToastProvider>,
  );

  return { onClose };
}

function typeReason(value: string): void {
  fireEvent.change(fieldByLabel(content.tickets.reassignReasonLabel), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.tickets.reassignSubmit }));
}

describe('the required reason', () => {
  beforeEach(() => {
    reassignTicketAction.mockReset();
    reassignTicketAction.mockResolvedValue({
      status: 'success',
      data: { ticketId: TICKET_ID, assignedUserId: PRIYA_ID },
    });
  });

  it('does not submit at all when the reason is empty', async () => {
    renderDialog();

    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });
    expect(reassignTicketAction).not.toHaveBeenCalled();
  });

  it('refuses whitespace, because it is not a reason', async () => {
    renderDialog();

    typeReason('   ');
    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });
    expect(reassignTicketAction).not.toHaveBeenCalled();
  });

  it('refuses a reason under the contract’s floor', async () => {
    renderDialog();

    typeReason('ok');
    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonTooShortError(3))).toBeInTheDocument();
    });
    expect(reassignTicketAction).not.toHaveBeenCalled();
  });

  it('clears the error as soon as the agent starts fixing it', async () => {
    renderDialog();

    submit();
    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });

    typeReason('Handing this over.');

    await waitFor(() => {
      expect(screen.queryByText(content.tickets.reasonRequiredError)).not.toBeInTheDocument();
    });
  });

  it('marks the control required and wires the error to it for a screen reader', () => {
    renderDialog();

    submit();

    const control = fieldByLabel(content.tickets.reassignReasonLabel);

    expect(control).toHaveAttribute('aria-invalid', 'true');
    expect(control.getAttribute('aria-describedby')).toBeTruthy();
  });
});

describe('a reassignment that goes through', () => {
  beforeEach(() => {
    reassignTicketAction.mockReset();
    reassignTicketAction.mockResolvedValue({
      status: 'success',
      data: { ticketId: TICKET_ID, assignedUserId: LIANG_ID },
    });
  });

  it('sends the picked teammate and the trimmed reason under the contract’s field names', async () => {
    renderDialog();

    fireEvent.change(fieldByLabel(content.tickets.reassignAgentLabel), {
      target: { value: LIANG_ID },
    });
    typeReason('  Going off shift, Liang has the history.  ');
    submit();

    await waitFor(() => {
      expect(reassignTicketAction).toHaveBeenCalledWith(TICKET_ID, {
        userId: LIANG_ID,
        reason: 'Going off shift, Liang has the history.',
      });
    });
  });

  it('names the ticket and the person in the confirmation rather than saying "Done"', async () => {
    renderDialog();

    fireEvent.change(fieldByLabel(content.tickets.reassignAgentLabel), {
      target: { value: LIANG_ID },
    });
    typeReason('Handing this over.');
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(content.tickets.reassignSuccess(LABEL, 'Liang Wei')),
      ).toBeInTheDocument();
    });
  });

  it('closes only after the write succeeded', async () => {
    const { onClose } = renderDialog();

    typeReason('Handing this over.');
    submit();

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the dialog open and the input intact when the API refuses', async () => {
    reassignTicketAction.mockResolvedValue({
      status: 'error',
      message: 'You can only hand a ticket to a teammate.',
      requestId: 'req-1',
    });

    const { onClose } = renderDialog();

    typeReason('Handing this to someone else.');
    submit();

    await waitFor(() => {
      expect(screen.getByText('You can only hand a ticket to a teammate.')).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    // A failed submit must never make the agent retype anything.
    expect(fieldByLabel(content.tickets.reassignReasonLabel)).toHaveValue(
      'Handing this to someone else.',
    );
  });
});

describe('when there is nobody to hand it to', () => {
  it('explains the bound instead of offering an empty picker', () => {
    renderDialog([]);

    expect(screen.getByText(content.tickets.reassignNoTeammates)).toBeInTheDocument();
    expect(screen.queryByLabelText(content.tickets.reassignAgentLabel)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.tickets.reassignSubmit })).toBeDisabled();
  });
});
