import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { SlaAlertView } from '@/features/sla/sla-alerts.data';
import { SlaAlertsPanel } from './SlaAlertsPanel';

/**
 * TAR-26's second acceptance criterion at the control level: a supervisor sees
 * what breached and can clear it.
 *
 * The two things worth pinning are the ones a reviewer cannot see by looking:
 * that the acknowledgement is optimistic, and that it *rolls back* — an optimistic
 * update whose failure path leaves the row gone is a success the console showed
 * for something that did not happen.
 */

const loadSlaAlertsAction = vi.fn();
const acknowledgeSlaAlertAction = vi.fn();

vi.mock('@/features/sla/sla.actions', () => ({
  loadSlaAlertsAction: (...args: unknown[]) => loadSlaAlertsAction(...args) as unknown,
  acknowledgeSlaAlertAction: (...args: unknown[]) => acknowledgeSlaAlertAction(...args) as unknown,
}));

const ALERT: SlaAlertView = {
  id: '0192f00c-0000-7000-8000-000000000c01',
  ticketId: '0192f00a-0000-7000-8000-000000000a01',
  ticketNumber: 1042,
  kind: 'first_response',
  dueAt: '2026-08-09T15:05:00.000Z',
  createdAt: '2026-08-09T15:05:30.000Z',
  acknowledgedAt: null,
  holderLabel: 'Amina Haddad',
  href: '/tickets/0192f00a-0000-7000-8000-000000000a01',
};

const REFERENCE = content.tickets.reference(ALERT.ticketNumber);
const ACKNOWLEDGE_LABEL = content.sla.acknowledgeAria(REFERENCE);

function renderPanel(onCountChange = vi.fn()) {
  return render(
    <ToastProvider>
      <SlaAlertsPanel onCountChange={onCountChange} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  loadSlaAlertsAction.mockReset();
  acknowledgeSlaAlertAction.mockReset();
  loadSlaAlertsAction.mockResolvedValue({
    status: 'success',
    data: { alerts: [ALERT], hasMore: false },
  });
  acknowledgeSlaAlertAction.mockResolvedValue({
    status: 'success',
    data: { ...ALERT, acknowledgedAt: '2026-08-13T10:00:00.000Z' },
  });
});

describe('SlaAlertsPanel', () => {
  it('announces the wait once, then swaps the skeleton for the alert', async () => {
    renderPanel();

    expect(screen.getByRole('status')).toHaveTextContent(content.sla.alertsLoading);

    expect(await screen.findByText(REFERENCE)).toBeInTheDocument();
    expect(screen.getByText(content.sla.kinds.first_response)).toBeInTheDocument();
    expect(screen.getByText(ALERT.holderLabel)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('links the row to the ticket rather than making the whole row a button', async () => {
    renderPanel();

    expect(await screen.findByRole('link', { name: new RegExp(REFERENCE) })).toHaveAttribute(
      'href',
      ALERT.href,
    );
  });

  it('reports the count to the bell above it, which outlives this panel', async () => {
    const onCountChange = vi.fn();

    renderPanel(onCountChange);

    await waitFor(() => {
      expect(onCountChange).toHaveBeenCalledWith(1, false);
    });
  });

  it('removes the row before the server answers, and says so once it has', async () => {
    const onCountChange = vi.fn();

    renderPanel(onCountChange);
    fireEvent.click(await screen.findByRole('button', { name: ACKNOWLEDGE_LABEL }));

    // Optimistic: gone without waiting for the round-trip.
    expect(screen.queryByRole('button', { name: ACKNOWLEDGE_LABEL })).toBeNull();
    expect(onCountChange).toHaveBeenLastCalledWith(0, false);

    expect(await screen.findByText(content.sla.acknowledgeSuccess(REFERENCE))).toBeInTheDocument();
    expect(acknowledgeSlaAlertAction).toHaveBeenCalledWith(ALERT.id);
  });

  it('puts the row back when the acknowledgement fails, and says why', async () => {
    // The half that makes the optimistic update honest. Without it the supervisor
    // is left believing they cleared something they did not.
    acknowledgeSlaAlertAction.mockResolvedValue({
      status: 'error',
      message: 'We could not save that.',
      requestId: 'req-1',
    });

    const onCountChange = vi.fn();

    renderPanel(onCountChange);
    fireEvent.click(await screen.findByRole('button', { name: ACKNOWLEDGE_LABEL }));

    expect(await screen.findByRole('button', { name: ACKNOWLEDGE_LABEL })).toBeInTheDocument();
    expect(await screen.findByText('We could not save that.')).toBeInTheDocument();
    expect(onCountChange).toHaveBeenLastCalledWith(1, false);
  });

  it('shows the queue as clear rather than an empty box', async () => {
    loadSlaAlertsAction.mockResolvedValue({
      status: 'success',
      data: { alerts: [], hasMore: false },
    });

    renderPanel();

    expect(await screen.findByText(content.sla.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.sla.emptyBody)).toBeInTheDocument();
  });

  it('offers a retry that actually re-reads when the list fails to load', async () => {
    loadSlaAlertsAction.mockResolvedValueOnce({
      status: 'error',
      message: 'We could not load that.',
      requestId: null,
    });

    renderPanel();

    expect(await screen.findByRole('alert')).toHaveTextContent('We could not load that.');

    fireEvent.click(screen.getByRole('button', { name: content.common.retry }));

    expect(await screen.findByText(REFERENCE)).toBeInTheDocument();
    expect(loadSlaAlertsAction).toHaveBeenCalledTimes(2);
  });

  it('says there are more rather than inventing a total it cannot know', async () => {
    loadSlaAlertsAction.mockResolvedValue({
      status: 'success',
      data: { alerts: [ALERT], hasMore: true },
    });

    renderPanel();

    expect(await screen.findByText(content.sla.moreAlerts)).toBeInTheDocument();
  });

  it('does not acknowledge twice when the button is double-clicked', async () => {
    let resolve: ((value: unknown) => void) | undefined;

    acknowledgeSlaAlertAction.mockReturnValue(
      new Promise((settle) => {
        resolve = settle;
      }),
    );

    renderPanel();

    const button = await screen.findByRole('button', { name: ACKNOWLEDGE_LABEL });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(acknowledgeSlaAlertAction).toHaveBeenCalledTimes(1);

    resolve?.({
      status: 'success',
      data: { ...ALERT, acknowledgedAt: '2026-08-13T10:00:00.000Z' },
    });
    await waitFor(() => {
      expect(acknowledgeSlaAlertAction).toHaveBeenCalledTimes(1);
    });
  });
});
