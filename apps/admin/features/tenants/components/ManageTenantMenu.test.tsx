import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { content } from '~/content/en';
import { tenantWrites } from '../tenant-presentation';
import { ManageTenantMenu } from './ManageTenantMenu';

const suspendTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const reactivateTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const cancelTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const deleteTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<unknown>>>();

vi.mock('../tenants.actions', () => ({
  suspendTenantAction: (input: unknown) => suspendTenantAction(input),
  reactivateTenantAction: (input: unknown) => reactivateTenantAction(input),
  cancelTenantAction: (input: unknown) => cancelTenantAction(input),
  deleteTenantAction: (input: unknown) => deleteTenantAction(input),
}));

const SLUG = 'northwind';

function renderMenu(status: Parameters<typeof tenantWrites>[0]) {
  return render(
    <ToastProvider>
      <ManageTenantMenu slug={SLUG} name={SLUG} writes={tenantWrites(status)} />
    </ToastProvider>,
  );
}

const openMenu = () => fireEvent.click(screen.getByRole('button', { name: content.tenant.manage }));

/**
 * Scoped to the open dialog. Every dialog is mounted at once — `isOpen` is a
 * prop, not a mount — and three of them carry a Reason field, so an unscoped
 * label query finds them all.
 */
function reasonIn(dialog: HTMLElement): HTMLElement {
  return within(dialog).getByLabelText(content.writes.reasonLabel);
}

describe('ManageTenantMenu', () => {
  beforeEach(() => {
    suspendTenantAction.mockReset();
    reactivateTenantAction.mockReset();
    cancelTenantAction.mockReset();
    deleteTenantAction.mockReset();
  });

  /**
   * The graph has no edge out of `deleted`, so every entry would exist only to
   * refuse. Omitted, not disabled.
   */
  it.each([null, 'deleted' as const])('renders nothing for %s', (status) => {
    renderMenu(status);

    expect(screen.queryByRole('button', { name: content.tenant.manage })).not.toBeInTheDocument();
  });

  it('offers only the writes the tenant’s state allows', () => {
    renderMenu('active');
    openMenu();

    expect(screen.getByRole('button', { name: content.writes.suspendTitle })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.writes.reactivateTitle }),
    ).not.toBeInTheDocument();
  });

  /**
   * The press that opens a confirmation is the operator asking a question, not
   * answering one.
   */
  it('confirms before suspending, and names what suspension costs', async () => {
    renderMenu('active');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: content.writes.suspendTitle }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(content.writes.suspendBody(SLUG))).toBeInTheDocument();
    expect(suspendTenantAction).not.toHaveBeenCalled();
  });

  it('sends the slug and the typed reason on confirmation', async () => {
    suspendTenantAction.mockResolvedValue({ status: 'success', data: SLUG });
    renderMenu('active');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: content.writes.suspendTitle }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonIn(dialog), {
      target: { value: 'fraud, card chargeback' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: content.writes.suspendSubmit }));

    await waitFor(() => {
      expect(suspendTenantAction).toHaveBeenCalledWith({
        slug: SLUG,
        reason: 'fraud, card chargeback',
      });
    });
  });

  /**
   * Every dialog is rendered at once — `isOpen` is a prop, not a mount — so the
   * one that is open must be the one that submits. `FormDialog` gives each form a
   * per-instance id for exactly this.
   */
  it('submits the dialog that is open, not the first one rendered', async () => {
    reactivateTenantAction.mockResolvedValue({ status: 'success', data: SLUG });
    renderMenu('suspended');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: content.writes.reactivateTitle }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: content.writes.reactivateSubmit }));

    await waitFor(() => {
      expect(reactivateTenantAction).toHaveBeenCalledTimes(1);
    });
    expect(suspendTenantAction).not.toHaveBeenCalled();
    expect(cancelTenantAction).not.toHaveBeenCalled();
    expect(deleteTenantAction).not.toHaveBeenCalled();
  });

  it('keeps the reason on a refusal rather than clearing the form', async () => {
    suspendTenantAction.mockResolvedValue({
      status: 'error',
      message: 'That tenant is already suspended.',
      requestId: 'req-1',
    });
    renderMenu('active');
    openMenu();
    fireEvent.click(screen.getByRole('button', { name: content.writes.suspendTitle }));

    const dialog = await screen.findByRole('dialog');
    fireEvent.change(reasonIn(dialog), { target: { value: 'why' } });
    fireEvent.click(within(dialog).getByRole('button', { name: content.writes.suspendSubmit }));

    expect(await screen.findByText('That tenant is already suspended.')).toBeInTheDocument();
    expect(reasonIn(dialog)).toHaveValue('why');
  });
});
