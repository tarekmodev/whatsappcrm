import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import { TenantLifecycleActions } from './TenantLifecycleActions';

const suspendTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const reactivateTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();

vi.mock('../platform-admin.actions', () => ({
  suspendTenantAction: (input: unknown) => suspendTenantAction(input),
  reactivateTenantAction: (input: unknown) => reactivateTenantAction(input),
}));

const copy = content.platformAdmin.tenant;

function renderActions(availability: { canSuspend: boolean; canReactivate: boolean }) {
  return render(
    <ToastProvider>
      <TenantLifecycleActions slug="northwind" availability={availability} />
    </ToastProvider>,
  );
}

describe('TenantLifecycleActions', () => {
  beforeEach(() => {
    suspendTenantAction.mockReset();
    reactivateTenantAction.mockReset();
  });

  it('offers only the actions the tenant’s state allows', () => {
    renderActions({ canSuspend: true, canReactivate: false });

    expect(screen.getByRole('button', { name: copy.suspend })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.reactivate })).not.toBeInTheDocument();
  });

  /**
   * A tenant whose trail could not be read offers neither. The screen still says
   * what it cannot do, rather than rendering an empty region.
   */
  it('offers neither when the state is unknown, and still names what is not built', () => {
    renderActions({ canSuspend: false, canReactivate: false });

    expect(screen.queryByRole('button', { name: copy.suspend })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.reactivate })).not.toBeInTheDocument();
    expect(screen.getByText(copy.impersonateNotice)).toBeInTheDocument();
  });

  /**
   * The most destructive control on the surface. It must not act on the press
   * that opens the dialog — that press is the operator asking a question.
   */
  it('confirms before suspending, and names what suspension costs', async () => {
    renderActions({ canSuspend: true, canReactivate: false });

    fireEvent.click(screen.getByRole('button', { name: copy.suspend }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(copy.suspendBody('northwind'))).toBeInTheDocument();
    expect(suspendTenantAction).not.toHaveBeenCalled();
  });

  it('sends the slug and the typed reason on confirmation', async () => {
    suspendTenantAction.mockResolvedValue({ status: 'success', data: 'northwind' });
    renderActions({ canSuspend: true, canReactivate: false });

    fireEvent.click(screen.getByRole('button', { name: copy.suspend }));
    const dialog = await screen.findByRole('dialog');

    fireEvent.change(fieldByLabel(copy.suspendReasonLabel), {
      target: { value: 'fraud, card chargeback' },
    });
    fireEvent.click(
      // The dialog's own submit, not the control that opened it — both carry the
      // same label, which is the point of scoping the query.
      within(dialog).getByRole('button', { name: copy.suspendConfirm }),
    );

    await waitFor(() => {
      expect(suspendTenantAction).toHaveBeenCalledWith({
        slug: 'northwind',
        reason: 'fraud, card chargeback',
      });
    });
  });

  /**
   * A failure keeps the operator's input and says what happened. Reported
   * outside the dialog as well, so a refusal that arrives after the dialog is
   * dismissed is not lost on a surface where the alternative to knowing is a
   * support ticket from the customer.
   */
  it('reports a refusal without clearing the reason', async () => {
    suspendTenantAction.mockResolvedValue({
      status: 'error',
      message: 'That tenant is already suspended.',
      requestId: 'req-1',
    });
    renderActions({ canSuspend: true, canReactivate: false });

    fireEvent.click(screen.getByRole('button', { name: copy.suspend }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(fieldByLabel(copy.suspendReasonLabel), {
      target: { value: 'why' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: copy.suspendConfirm }));

    expect(await screen.findAllByText('That tenant is already suspended.')).not.toHaveLength(0);
    expect(fieldByLabel(copy.suspendReasonLabel)).toHaveValue('why');
  });

  it('confirms before reactivating too', async () => {
    reactivateTenantAction.mockResolvedValue({ status: 'success', data: 'northwind' });
    renderActions({ canSuspend: false, canReactivate: true });

    fireEvent.click(screen.getByRole('button', { name: copy.reactivate }));
    const dialog = await screen.findByRole('dialog');

    expect(screen.getByText(copy.reactivateBody('northwind'))).toBeInTheDocument();
    expect(reactivateTenantAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: copy.reactivateConfirm }));

    await waitFor(() => {
      expect(reactivateTenantAction).toHaveBeenCalledWith({ slug: 'northwind' });
    });
  });

  /**
   * Both dialogs are rendered at once — `isOpen` is a prop, not a mount — so the
   * one that is open must be the one that submits. `FormDialog` gives each form
   * a per-instance id for exactly this; a shared id made Reactivate drive the
   * Suspend dialog's form.
   */
  it('submits the dialog that is open, not the first one rendered', async () => {
    reactivateTenantAction.mockResolvedValue({ status: 'success', data: 'northwind' });
    renderActions({ canSuspend: true, canReactivate: true });

    fireEvent.click(screen.getByRole('button', { name: copy.reactivate }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: copy.reactivateConfirm }));

    await waitFor(() => {
      expect(reactivateTenantAction).toHaveBeenCalledTimes(1);
    });
    expect(suspendTenantAction).not.toHaveBeenCalled();
  });
});
