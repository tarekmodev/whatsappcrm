import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { content } from '~/content/en';
import { DeleteTenantDialog } from './DeleteTenantDialog';

const deleteTenantAction = vi.fn<(input: unknown) => Promise<ActionResult<unknown>>>();

vi.mock('../tenants.actions', () => ({
  deleteTenantAction: (input: unknown) => deleteTenantAction(input),
}));

const SLUG = 'northwind';

function renderDialog() {
  return render(
    <ToastProvider>
      <DeleteTenantDialog slug={SLUG} name={SLUG} isOpen onClose={() => {}} />
    </ToastProvider>,
  );
}

const submit = () =>
  screen.getByRole('button', {
    name: new RegExp(
      `^(${content.writes.deleteScheduledSubmit}|${content.writes.deleteImmediateSubmit})$`,
    ),
  });

const chooseMode = (value: 'scheduled' | 'immediate') =>
  fireEvent.change(screen.getByLabelText(content.writes.deleteModeLabel), { target: { value } });

describe('DeleteTenantDialog', () => {
  beforeEach(() => {
    deleteTenantAction.mockReset();
    deleteTenantAction.mockResolvedValue({
      status: 'success',
      data: { slug: SLUG, force: false, state: {} },
    });
  });

  /**
   * The safe mode is the default, so a hurried operator schedules rather than
   * destroys. The submit's verb says which one it is, so the button never reads
   * milder than what pressing it does.
   */
  it('opens on the scheduled mode', () => {
    renderDialog();

    expect(submit()).toHaveTextContent(content.writes.deleteScheduledSubmit);
    expect(screen.queryByLabelText(content.writes.deleteConfirmLabel)).not.toBeInTheDocument();
  });

  it('schedules without a confirmation, because it destroys nothing yet', async () => {
    renderDialog();

    fireEvent.click(submit());

    await waitFor(() => {
      expect(deleteTenantAction).toHaveBeenCalledWith({ slug: SLUG, force: false, reason: '' });
    });
  });

  /**
   * The only type-to-confirm in the product. This is the one action that destroys
   * customer data on a clock the operator just shortened.
   */
  it('demands the slug before it will delete immediately', async () => {
    renderDialog();
    chooseMode('immediate');

    expect(submit()).toHaveTextContent(content.writes.deleteImmediateSubmit);
    expect(screen.getByText(content.writes.deleteImmediateWarning(SLUG))).toBeInTheDocument();

    fireEvent.click(submit());
    expect(deleteTenantAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(content.writes.deleteConfirmLabel), {
      target: { value: 'not-the-slug' },
    });
    fireEvent.click(submit());
    expect(deleteTenantAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText(content.writes.deleteConfirmLabel), {
      target: { value: SLUG },
    });
    fireEvent.click(submit());

    await waitFor(() => {
      expect(deleteTenantAction).toHaveBeenCalledWith({ slug: SLUG, force: true, reason: '' });
    });
  });

  /**
   * Switching away and back must not leave a matching slug behind: that would let
   * a second pass submit an immediate deletion with no fresh confirmation at all.
   */
  it('drops the confirmation when the mode changes', () => {
    renderDialog();
    chooseMode('immediate');
    fireEvent.change(screen.getByLabelText(content.writes.deleteConfirmLabel), {
      target: { value: SLUG },
    });

    chooseMode('scheduled');
    chooseMode('immediate');

    expect(screen.getByLabelText(content.writes.deleteConfirmLabel)).toHaveValue('');
    fireEvent.click(submit());
    expect(deleteTenantAction).not.toHaveBeenCalled();
  });
});
