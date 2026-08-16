import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { UserResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { EscalateTicketDialog } from './EscalateTicketDialog';

/**
 * TAR-32 AC2: an agent can escalate to a supervisor **with a required reason**.
 *
 * The other thing worth pinning here is the empty-recipient outcome: a tenant
 * with no active supervisor still gets the escalation recorded, and the console
 * has to say so rather than showing a green tick (ADR 0011 decision 3).
 */
const escalateTicketAction =
  vi.fn<
    (
      ticketId: string,
      input: unknown,
    ) => Promise<ActionResult<{ ticketId: string; notifiedCount: number }>>
  >();

vi.mock('../ticket-handoff.actions', () => ({
  escalateTicketAction: (ticketId: string, input: unknown) => escalateTicketAction(ticketId, input),
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/tickets/0192f00a-0000-7000-8000-000000000a01',
}));

const TICKET_ID = '0192f00a-0000-7000-8000-000000000a01';
const PRIYA_ID = '0192f001-0000-7000-8000-000000000102';
const LABEL = 'July invoice never arrived';

const SUPERVISORS: UserResponse[] = [
  {
    id: PRIYA_ID,
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
    createdAt: '2026-07-02T10:00:00.000Z',
  },
];

function renderDialog(supervisors: readonly UserResponse[] = SUPERVISORS, onClose = vi.fn()) {
  render(
    <ToastProvider>
      <EscalateTicketDialog
        ticketId={TICKET_ID}
        label={LABEL}
        supervisors={supervisors}
        onClose={onClose}
      />
    </ToastProvider>,
  );

  return { onClose };
}

function typeReason(value: string): void {
  fireEvent.change(fieldByLabel(content.tickets.escalateReasonLabel), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.tickets.escalateSubmit }));
}

beforeEach(() => {
  escalateTicketAction.mockReset();
  escalateTicketAction.mockResolvedValue({
    status: 'success',
    data: { ticketId: TICKET_ID, notifiedCount: 2 },
  });
});

describe('the required reason', () => {
  it('does not submit at all when the reason is empty', async () => {
    renderDialog();

    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });
    expect(escalateTicketAction).not.toHaveBeenCalled();
  });

  it('refuses whitespace and a value under the contract’s floor', async () => {
    renderDialog();

    typeReason('  ');
    submit();
    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonRequiredError)).toBeInTheDocument();
    });

    typeReason('no');
    submit();
    await waitFor(() => {
      expect(screen.getByText(content.tickets.reasonTooShortError(3))).toBeInTheDocument();
    });

    expect(escalateTicketAction).not.toHaveBeenCalled();
  });
});

describe('what gets sent', () => {
  it('omits toUserId when the escalation is not addressed to a person', async () => {
    renderDialog();

    typeReason('  Needs a refund decision today.  ');
    submit();

    await waitFor(() => {
      expect(escalateTicketAction).toHaveBeenCalledWith(TICKET_ID, {
        reason: 'Needs a refund decision today.',
      });
    });
  });

  it('sends the named supervisor when one is picked', async () => {
    renderDialog();

    typeReason('Priya has the history on this account.');
    fireEvent.change(fieldByLabel(content.tickets.escalateSupervisorLabel), {
      target: { value: PRIYA_ID },
    });
    submit();

    await waitFor(() => {
      expect(escalateTicketAction).toHaveBeenCalledWith(TICKET_ID, {
        reason: 'Priya has the history on this account.',
        toUserId: PRIYA_ID,
      });
    });
  });

  it('defaults to "whoever is covering this ticket" rather than a person', () => {
    renderDialog();

    expect(
      screen.getByRole('option', { name: content.tickets.escalateSupervisorAnyone }),
    ).toBeInTheDocument();
    expect(fieldByLabel(content.tickets.escalateSupervisorLabel)).toHaveValue('anyone');
  });
});

describe('what the agent is told afterwards', () => {
  it('says how many people were notified, not just "Done"', async () => {
    renderDialog();

    typeReason('Needs a refund decision today.');
    submit();

    await waitFor(() => {
      expect(screen.getByText(content.tickets.escalateSuccess(LABEL, 2))).toBeInTheDocument();
    });
  });

  it('says it was recorded but undelivered when nobody could be notified', async () => {
    escalateTicketAction.mockResolvedValue({
      status: 'success',
      data: { ticketId: TICKET_ID, notifiedCount: 0 },
    });

    renderDialog();

    typeReason('Needs a refund decision today.');
    submit();

    // Not a green tick, and not an error: the agent did nothing wrong and
    // cannot fix it, so the copy names who can.
    await waitFor(() => {
      expect(screen.getByText(content.tickets.escalateSuccessNobody(LABEL))).toBeInTheDocument();
    });
  });

  it('keeps the dialog open and the reason intact when the API refuses', async () => {
    escalateTicketAction.mockResolvedValue({
      status: 'error',
      message: 'That person cannot receive an escalation for this ticket.',
      requestId: 'req-2',
    });

    const { onClose } = renderDialog();

    typeReason('Asking Liang to look at this.');
    submit();

    await waitFor(() => {
      expect(
        screen.getByText('That person cannot receive an escalation for this ticket.'),
      ).toBeInTheDocument();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(fieldByLabel(content.tickets.escalateReasonLabel)).toHaveValue(
      'Asking Liang to look at this.',
    );
  });
});
