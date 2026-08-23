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

function limitField(): HTMLElement {
  return fieldByLabel(content.assignment.raiseLimitValueLabel);
}

function useDefaultBox(): HTMLElement {
  return screen.getByLabelText(content.assignment.raiseLimitUseDefaultLabel(WORKSPACE_DEFAULT));
}

function typeLimit(value: string): void {
  fireEvent.change(limitField(), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.assignment.raiseLimitSubmit }));
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

    expect(screen.getByText(content.assignment.raiseLimitLoadSummary(2, 2))).toBeInTheDocument();
    expect(limitField()).toHaveValue(2);
  });

  /**
   * The numbers are the whole decision, so they are a real `progressbar` as well
   * as a sentence — the bar alone would be colour, and colour is never the only
   * carrier.
   */
  it('publishes the load as a measured progressbar, not only as a bar', () => {
    renderDialog();

    const meter = screen.getByRole('progressbar', {
      name: content.assignment.raiseLimitLoadHeading,
    });

    expect(meter).toHaveAttribute('aria-valuenow', '2');
    expect(meter).toHaveAttribute('aria-valuemax', '2');
  });

  /**
   * Switching agent replaces every part of the reading at once, so it belongs in
   * one polite region rather than announcing heading, numbers and provenance as
   * three separate changes.
   */
  it('announces the reading politely, in one region', () => {
    renderDialog();

    const region = screen.getByRole('status');

    expect(region).toHaveTextContent(content.assignment.raiseLimitLoadSummary(2, 2));
    expect(region).toHaveTextContent(content.assignment.raiseLimitOverridden);
  });

  /**
   * The single-agent scope is TAR-755's acceptance criterion, and the hint is
   * where it reaches the person using the control rather than staying in the
   * issue.
   */
  it('tells the supervisor that only the picked agent changes', () => {
    renderDialog();

    expect(screen.getByText(content.assignment.raiseLimitAgentHint(false))).toBeInTheDocument();
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
        screen.getByText(content.assignment.raiseLimitSuccess('Amina Haddad', 4)),
      ).toBeInTheDocument();
    });
    expect(onClose).toHaveBeenCalled();
  });

  /**
   * `null` clears the override; omitting the field would leave it alone. The two
   * are distinct on the wire, and this is the only way back to the workspace
   * default from the console — without it the dialog is a one-way door (TAR-778).
   */
  it('clears the override to the workspace default rather than sending nothing', async () => {
    updateAgentCapacityAction.mockResolvedValue({
      status: 'success',
      data: { userId: AMINA_ID, maxConcurrentTickets: null },
    });
    renderDialog();

    fireEvent.click(useDefaultBox());
    submit();

    await waitFor(() => {
      expect(updateAgentCapacityAction).toHaveBeenCalledWith(AMINA_ID, {
        maxConcurrentTickets: null,
      });
    });
    expect(
      screen.getByText(
        content.assignment.raiseLimitClearedSuccess('Amina Haddad', WORKSPACE_DEFAULT),
      ),
    ).toBeInTheDocument();
  });

  /**
   * The checkbox and the number are never both authoritative. Ticking it disables
   * the field and rewrites it to the limit that would actually apply, rather than
   * hiding it — a field that vanishes takes the reader's place in the form with
   * it.
   */
  it('disables the number field and shows the default while the box is ticked', () => {
    renderDialog();

    fireEvent.click(useDefaultBox());

    expect(limitField()).toBeDisabled();
    expect(limitField()).toHaveValue(WORKSPACE_DEFAULT);

    fireEvent.click(useDefaultBox());

    expect(limitField()).toBeEnabled();
  });

  /** The validation state: caught before the round trip, and never sent. */
  it('refuses a limit outside the contract’s bounds, in the field', async () => {
    renderDialog();

    typeLimit(String(ASSIGNMENT_POLICY.maxMaxConcurrentTickets + 1));
    submit();

    await waitFor(() => {
      expect(
        screen.getByText(
          content.assignment.raiseLimitValueError(
            ASSIGNMENT_POLICY.minMaxConcurrentTickets,
            ASSIGNMENT_POLICY.maxMaxConcurrentTickets,
          ),
        ),
      ).toBeInTheDocument();
    });
    expect(updateAgentCapacityAction).not.toHaveBeenCalled();
  });

  /**
   * A server range refusal is about the one value this dialog lets anybody type,
   * so it lands beside that value rather than in a banner the reader then has to
   * match up with a field.
   */
  it('puts a server validation failure in the field, not above the form', async () => {
    renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'maxConcurrentTickets must be between 1 and 1000.',
      requestId: 'req-2',
      code: 'validation_failed',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(limitField()).toHaveAttribute('aria-invalid', 'true');
    });

    const message = screen.getByText('maxConcurrentTickets must be between 1 and 1000.');

    // Wired to the input rather than floating above the form, so a screen reader
    // hears it on the control it belongs to.
    expect(limitField().getAttribute('aria-describedby')).toContain(message.id);
  });

  /**
   * Two refusals the supervisor cannot answer from in here. The API's own message
   * is replaced with one that says what to do, and the submit is blocked rather
   * than left to refuse a second time.
   */
  it.each([
    ['forbidden', content.assignment.raiseLimitForbidden],
    ['not_found', content.assignment.raiseLimitNotFound],
  ])('blocks the submit and says what to do on %s', async (code, copy) => {
    const { onClose } = renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'Changing an agent’s ticket limit requires the assignment_rule:write permission.',
      requestId: 'req-1',
      code,
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(screen.getByText(copy)).toBeInTheDocument();
    });
    expect(
      screen.getByRole('button', { name: content.assignment.raiseLimitSubmit }),
    ).toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
    // Nothing is cleared, so a reload-and-retry costs no retyping.
    expect(limitField()).toHaveValue(4);

    // And a new number does not release it: neither refusal is about the value,
    // so re-enabling the submit here would only buy a second identical failure.
    typeLimit('6');

    expect(screen.getByText(copy)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.assignment.raiseLimitSubmit }),
    ).toBeDisabled();
  });

  /**
   * `not_found` is about the agent it was made for. `useActionForm` only clears on
   * the next submit and the code disables the submit, so without an explicit clear
   * the dialog goes on insisting an agent is gone after the supervisor has already
   * picked somebody else — a dead end whose only exit is a reload.
   */
  it('lets the supervisor out of a missing-agent refusal by picking another agent', async () => {
    renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'That agent is no longer in this workspace.',
      requestId: 'req-4',
      code: 'not_found',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(screen.getByText(content.assignment.raiseLimitNotFound)).toBeInTheDocument();
    });

    fireEvent.change(fieldByLabel(content.assignment.raiseLimitAgentLabel), {
      target: { value: LIANG_ID },
    });

    expect(screen.queryByText(content.assignment.raiseLimitNotFound)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: content.assignment.raiseLimitSubmit })).toBeEnabled();
  });

  /**
   * The pair to the one above, and the reason the clear is not unconditional:
   * `forbidden` is about the session, not the agent. No name in the picker carries
   * the permission back, so releasing the submit here would only buy the supervisor
   * a second 403 — the copy tells them to reload, and the dialog has to keep
   * meaning it.
   */
  it('keeps a permission refusal in place across an agent change', async () => {
    renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'Changing an agent’s ticket limit requires the assignment_rule:write permission.',
      requestId: 'req-6',
      code: 'forbidden',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(screen.getByText(content.assignment.raiseLimitForbidden)).toBeInTheDocument();
    });

    fireEvent.change(fieldByLabel(content.assignment.raiseLimitAgentLabel), {
      target: { value: LIANG_ID },
    });

    expect(screen.getByText(content.assignment.raiseLimitForbidden)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.assignment.raiseLimitSubmit }),
    ).toBeDisabled();
  });

  /**
   * The field error is about the value that caused it. Left in place it keeps
   * `aria-invalid` and the server's message on a number nobody typed — and across
   * an agent change it would sit under somebody else's name.
   */
  it('drops the server field error once the value it refused is gone', async () => {
    renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'maxConcurrentTickets must be between 1 and 1000.',
      requestId: 'req-5',
      code: 'validation_failed',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(limitField()).toHaveAttribute('aria-invalid', 'true');
    });

    typeLimit('6');

    expect(limitField()).not.toHaveAttribute('aria-invalid', 'true');
    expect(
      screen.queryByText('maxConcurrentTickets must be between 1 and 1000.'),
    ).not.toBeInTheDocument();
  });

  /** Anything else keeps the action's own message, because it is worth retrying. */
  it('keeps the API’s message and the submit for a retryable failure', async () => {
    renderDialog();

    updateAgentCapacityAction.mockResolvedValue({
      status: 'error',
      message: 'That limit conflicts with a change somebody else just made.',
      requestId: 'req-3',
      code: 'conflict',
    });

    typeLimit('4');
    submit();

    await waitFor(() => {
      expect(
        screen.getByText('That limit conflicts with a change somebody else just made.'),
      ).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: content.assignment.raiseLimitSubmit })).toBeEnabled();
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
      screen.getByText(content.assignment.raiseLimitBelowLoad('Amina Haddad', 2, 1)),
    ).toBeInTheDocument();
  });

  /**
   * Same condition, same warning, whichever way the supervisor got there: a
   * workspace default below the agent's load is the identical trap as typing a low
   * number, and two code paths for it would mean one of them stopped warning.
   */
  it('warns just the same when the workspace default is below the load', () => {
    render(
      <ToastProvider>
        <AgentCapacityDialog
          rows={ROWS}
          // Amina holds 2; inheriting a default of 1 leaves her over it.
          workspaceDefault={1}
          hasMore={false}
          onClose={vi.fn()}
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByLabelText(content.assignment.raiseLimitUseDefaultLabel(1)));

    expect(
      screen.getByText(content.assignment.raiseLimitBelowLoad('Amina Haddad', 2, 1)),
    ).toBeInTheDocument();
  });

  it('re-reads the form from the agent that was picked, not the one before', () => {
    renderDialog();

    fireEvent.change(fieldByLabel(content.assignment.raiseLimitAgentLabel), {
      target: { value: LIANG_ID },
    });

    // Liang inherits, so the form switches to the workspace default rather than
    // carrying Amina's 2 across under his name.
    expect(
      screen.getByText(content.assignment.raiseLimitLoadSummary(1, WORKSPACE_DEFAULT)),
    ).toBeInTheDocument();
    expect(
      screen.getByText(content.assignment.raiseLimitInherited(WORKSPACE_DEFAULT)),
    ).toBeInTheDocument();
    expect(limitField()).toBeDisabled();
  });

  it('says out loud when the picker holds only the first page of agents', () => {
    renderDialog(vi.fn(), true);

    expect(screen.getByText(content.assignment.raiseLimitAgentHint(true))).toBeInTheDocument();
  });

  /**
   * Practically unreachable — `loadAgentCapacity` returns `null` rather than an
   * empty report — but a control that opened onto nothing must say so and refuse
   * the submit, not crash or offer a save with no subject.
   */
  it('renders the empty case rather than a form with nothing to change', () => {
    render(
      <ToastProvider>
        <AgentCapacityDialog
          rows={[]}
          workspaceDefault={WORKSPACE_DEFAULT}
          hasMore={false}
          onClose={vi.fn()}
        />
      </ToastProvider>,
    );

    expect(screen.getByText(content.assignment.raiseLimitNoAgentsError)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.assignment.raiseLimitSubmit }),
    ).toBeDisabled();
  });
});
