import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { TicketControls } from './TicketControls';

/**
 * TAR-25's first and third acceptance criteria at the control level, plus the
 * two rules ADR 0006 is most easily got wrong on: which moves are offered at
 * all, and which of them are one-way.
 */

const updateTicketAction = vi.fn();
const refresh = vi.fn();

vi.mock('@/features/tickets/tickets.actions', () => ({
  updateTicketAction: (...args: unknown[]) => updateTicketAction(...args) as unknown,
}));

vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh }),
}));

const TICKET_ID = '0192f00a-0000-7000-8000-000000000a01';
const LABEL = 'July invoice never arrived';

function renderControls(
  overrides: Partial<Parameters<typeof TicketControls>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <TicketControls
        ticketId={TICKET_ID}
        label={LABEL}
        status="open"
        priority="normal"
        canUpdate
        canClose
        {...overrides}
      />
    </ToastProvider>,
  );
}

beforeEach(() => {
  updateTicketAction.mockReset();
  updateTicketAction.mockResolvedValue({
    status: 'success',
    data: { label: LABEL, status: 'resolved', priority: 'normal' },
  });
  refresh.mockReset();
});

describe('which moves are offered', () => {
  it('renders one button per transition the contract allows out of the current status', () => {
    renderControls({ status: 'open' });

    expect(
      screen.getByRole('button', { name: content.tickets.statusActions.pending }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.tickets.statusActions.resolved }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.tickets.statusActions.closed }),
    ).toBeInTheDocument();
    // `open → open` is the no-op, not a move.
    expect(screen.queryByRole('button', { name: content.tickets.statusActions.open })).toBeNull();
  });

  it('offers nothing out of a closed ticket, and says why', () => {
    renderControls({ status: 'closed' });

    expect(screen.queryByRole('button', { name: content.tickets.statusActions.open })).toBeNull();
    expect(screen.getByText(content.tickets.statusFinal)).toBeInTheDocument();
  });

  it('hides the terminal pair without ticket:close, and explains the gap', () => {
    renderControls({ status: 'open', canClose: false });

    expect(
      screen.getByRole('button', { name: content.tickets.statusActions.pending }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.tickets.statusActions.resolved }),
    ).toBeNull();
    expect(screen.getByText(content.tickets.closeNotPermitted)).toBeInTheDocument();
  });

  it('renders values rather than controls without ticket:update', () => {
    renderControls({ canUpdate: false, status: 'open', priority: 'high' });

    expect(
      screen.queryByRole('button', { name: content.tickets.statusActions.pending }),
    ).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByText(content.tickets.updateNotPermitted)).toBeInTheDocument();
    expect(screen.getByText(content.ticketPriorities.high)).toBeInTheDocument();
  });
});

describe('reversible moves apply straight away', () => {
  it('sends open → pending with no confirmation', async () => {
    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.pending }));

    await waitFor(() => {
      expect(updateTicketAction).toHaveBeenCalledWith(TICKET_ID, { status: 'pending' });
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('sends a priority change straight away and reports what it became', async () => {
    updateTicketAction.mockResolvedValue({
      status: 'success',
      data: { label: LABEL, status: 'open', priority: 'urgent' },
    });

    renderControls({ status: 'open', priority: 'normal' });

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'urgent' } });

    await waitFor(() => {
      expect(updateTicketAction).toHaveBeenCalledWith(TICKET_ID, { priority: 'urgent' });
    });
    expect(
      await screen.findByText(
        content.tickets.priorityChangeSuccess(LABEL, content.ticketPriorities.urgent),
      ),
    ).toBeInTheDocument();
  });

  it('rolls the priority control back to the server’s value when the change is refused', async () => {
    updateTicketAction.mockResolvedValue({
      status: 'error',
      message: 'This ticket is closed and cannot be changed.',
      requestId: 'req-1',
    });

    renderControls({ status: 'open', priority: 'normal' });

    const select = screen.getByRole('combobox');

    fireEvent.change(select, { target: { value: 'urgent' } });

    // Never a success left on screen that did not happen.
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This ticket is closed and cannot be changed.',
    );
    await waitFor(() => {
      expect(select).toHaveValue('normal');
    });
  });
});

describe('one-way moves are confirmed', () => {
  it('writes nothing on the first click — the confirmation comes first', async () => {
    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.resolved }));

    // The dialog is a lazy chunk; wait for it rather than for a fixed tick.
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(updateTicketAction).not.toHaveBeenCalled();
  });

  it('names what will happen and what cannot be undone', async () => {
    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.resolved }));
    await screen.findByRole('dialog');

    expect(
      screen.getByText(content.tickets.terminalConfirm.resolved.body(LABEL)),
    ).toBeInTheDocument();
  });

  it('resolves once confirmed, and says so', async () => {
    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.resolved }));
    await screen.findByRole('dialog');
    fireEvent.click(
      screen.getByRole('button', { name: content.tickets.terminalConfirm.resolved.confirm }),
    );

    await waitFor(() => {
      expect(updateTicketAction).toHaveBeenCalledWith(TICKET_ID, { status: 'resolved' });
    });
    expect(
      await screen.findByText(
        content.tickets.statusChangeSuccess(LABEL, content.ticketStatuses.resolved),
      ),
    ).toBeInTheDocument();
  });

  it('cancels without writing anything', async () => {
    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.closed }));
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: content.common.cancel }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
    expect(updateTicketAction).not.toHaveBeenCalled();
  });
});

describe('a lost race', () => {
  it('refetches the view so the agent sees what moved under them', async () => {
    // A `conflict` means the customer replied and the ticket reopened. The
    // *reason* is the new inbound message, and refreshing on failure is what
    // puts it on screen.
    updateTicketAction.mockResolvedValue({
      status: 'error',
      message: 'This ticket is open and cannot be moved to resolved.',
      requestId: 'req-2',
    });

    renderControls({ status: 'open' });

    fireEvent.click(screen.getByRole('button', { name: content.tickets.statusActions.pending }));

    await waitFor(() => {
      expect(refresh).toHaveBeenCalled();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This ticket is open and cannot be moved to resolved.',
    );
  });

  it('does not fire twice when a button is double-clicked', async () => {
    let resolve: ((value: unknown) => void) | undefined;

    updateTicketAction.mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );

    renderControls({ status: 'open' });

    const button = screen.getByRole('button', { name: content.tickets.statusActions.pending });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(updateTicketAction).toHaveBeenCalledTimes(1);

    resolve?.({ status: 'success', data: { label: LABEL, status: 'pending', priority: 'normal' } });
    await waitFor(() => {
      expect(button).not.toHaveAttribute('aria-disabled');
    });
  });
});
