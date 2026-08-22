import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SLA_WINDOW_MAX_MINUTES, type SlaPolicyResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { ActionResult } from '@/lib/actions/result';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { SLA_WINDOW_MIN_MINUTES } from '../window-form';
import { SlaWindowDetails } from './SlaWindowDetails';
import { SlaWindowForm } from './SlaWindowForm';

const updateSlaWindowAction =
  vi.fn<(policyId: string, input: unknown) => Promise<ActionResult<undefined>>>();

vi.mock('@/features/sla/sla-policies.actions', () => ({
  updateSlaWindowAction: (policyId: string, input: unknown) =>
    updateSlaWindowAction(policyId, input),
}));

/**
 * TAR-390's three acceptance criteria, at the layer that can actually be wrong:
 *
 *   1. **The current window is shown** — the fields open on the saved values.
 *   2. **A change is a `PATCH` of the whole form**, with an emptied window sent
 *      as `null` rather than as `0`, `''` or `NaN`. What an edit does to running
 *      timers belongs to the API and is asserted there; what the console owes is
 *      saying so, which the section card does above this form.
 *   3. **A principal without `sla:write` gets facts, not disabled controls** —
 *      the read-only variant is a `<dl>`, so its values stay reachable by
 *      keyboard rather than being skipped as a disabled input would be.
 */

const POLICY: SlaPolicyResponse = {
  id: '0192f010-0000-7000-8000-000000001001',
  name: 'Default',
  priority: null,
  firstResponseMinutes: 60,
  resolutionMinutes: null,
  businessHoursOnly: false,
  isActive: true,
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-01T09:00:00.000Z',
};

const copy = content.slaSettings;

function renderForm(policy: SlaPolicyResponse = POLICY) {
  return render(
    <ToastProvider>
      <SlaWindowForm policy={policy} />
    </ToastProvider>,
  );
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: copy.save }));
}

describe('SlaWindowForm', () => {
  beforeEach(() => {
    updateSlaWindowAction.mockReset();
    updateSlaWindowAction.mockResolvedValue({ status: 'success', data: undefined });
  });

  it('opens on the window the workspace has now', () => {
    renderForm();

    expect(fieldByLabel(copy.firstResponseLabel)).toHaveValue(60);
    expect(fieldByLabel(copy.resolutionLabel)).toHaveValue(null);
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('names the standard setting, so a changed workspace can be told from an untouched one', () => {
    renderForm();

    // The platform's own 60 minutes, phrased — the figure in the field is this
    // workspace's, and one without the other says nothing.
    expect(screen.getByText(copy.firstResponseHint('1 hour'))).toBeInTheDocument();
  });

  it('saves the whole form, with an emptied window sent as null', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(copy.firstResponseLabel), { target: { value: '30' } });
    submit();

    await waitFor(() => {
      expect(updateSlaWindowAction).toHaveBeenCalledWith(POLICY.id, {
        isActive: true,
        firstResponseMinutes: 30,
        resolutionMinutes: null,
      });
    });
  });

  it('sends a resolution window once one is typed', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(copy.resolutionLabel), { target: { value: '480' } });
    submit();

    await waitFor(() => {
      expect(updateSlaWindowAction).toHaveBeenCalledWith(
        POLICY.id,
        expect.objectContaining({ resolutionMinutes: 480 }),
      );
    });
  });

  it('turns deadlines off without touching the windows underneath', async () => {
    renderForm();

    fireEvent.click(screen.getByRole('switch'));
    submit();

    await waitFor(() => {
      expect(updateSlaWindowAction).toHaveBeenCalledWith(
        POLICY.id,
        expect.objectContaining({ isActive: false, firstResponseMinutes: 60 }),
      );
    });
  });

  /**
   * The ceiling is thirty days. A window entered in seconds is the typo it
   * exists to catch, and catching it here rather than at the API is what keeps
   * the message beside the field that caused it.
   */
  it('refuses a window outside the contract’s bounds and focuses the field', () => {
    renderForm();

    const field = fieldByLabel(copy.firstResponseLabel);

    fireEvent.change(field, { target: { value: '999999' } });
    submit();

    expect(updateSlaWindowAction).not.toHaveBeenCalled();
    expect(field).toHaveFocus();
    expect(
      screen.getByText(copy.windowInvalidError(SLA_WINDOW_MIN_MINUTES, SLA_WINDOW_MAX_MINUTES)),
    ).toBeInTheDocument();
  });

  it('keeps what was typed when the save fails', async () => {
    updateSlaWindowAction.mockResolvedValue({
      status: 'error',
      message: 'Nope',
      requestId: null,
    });
    renderForm();

    fireEvent.change(fieldByLabel(copy.firstResponseLabel), { target: { value: '15' } });
    submit();

    expect(await screen.findByText('Nope')).toBeInTheDocument();
    expect(fieldByLabel(copy.firstResponseLabel)).toHaveValue(15);
  });
});

describe('SlaWindowDetails', () => {
  /**
   * The role-denial case. A principal who may read but not write meets text,
   * never a disabled form: `disabled` reads as "not right now" rather than
   * "never for you", and a disabled control is skipped by keyboard navigation,
   * so its value becomes unreadable to anyone tabbing through.
   */
  it('shows the window as facts with no control to submit', () => {
    // A workspace that has changed its window, so the two figures the first
    // acceptance criterion asks for are distinguishable: what this workspace
    // uses, and the standard it diverged from.
    render(<SlaWindowDetails policy={{ ...POLICY, firstResponseMinutes: 45 }} />);

    expect(screen.getByText('45 minutes')).toBeInTheDocument();
    expect(screen.getByText('1 hour')).toBeInTheDocument();
    expect(screen.getByText(copy.windowUnset)).toBeInTheDocument();
    expect(screen.getByText(copy.activeYes)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });
});
