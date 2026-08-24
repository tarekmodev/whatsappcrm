import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { FormDialog } from './FormDialog';
import { TextInput } from './TextInput';

vi.mock('next/navigation', () => ({
  usePathname: () => '/settings/people',
}));

/**
 * The two protections a dialog holding a form gets that a dialog holding a view
 * does not (0002 §1.4). Both are about the same thing: Escape and a stray click
 * are cheap to reach and expensive to be wrong about.
 */
describe('FormDialog', () => {
  function renderDialog({ withField = true }: { withField?: boolean } = {}) {
    const onClose = vi.fn();

    render(
      <FormDialog
        isOpen
        title="Invite an agent"
        submitLabel="Send invitation"
        isPending={false}
        formError={null}
        onSubmit={vi.fn()}
        onClose={onClose}
      >
        {withField ? <TextInput name="email" aria-label="Email address" /> : null}
      </FormDialog>,
    );

    return { onClose, dialog: screen.getByRole('dialog', { name: 'Invite an agent' }) };
  }

  function pressEscape(dialog: HTMLElement): void {
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
  }

  it('closes on Escape while nothing has been typed', () => {
    const { onClose, dialog } = renderDialog();

    pressEscape(dialog);

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: /discard/i })).not.toBeInTheDocument();
  });

  it('confirms before discarding once the reader has typed something', () => {
    const { onClose, dialog } = renderDialog();

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'amina@example.com' },
    });
    pressEscape(dialog);

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Discard your changes?' })).toBeInTheDocument();
  });

  it('keeps editing when the confirmation is dismissed', () => {
    const { onClose, dialog } = renderDialog();

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a' } });
    pressEscape(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Discard your changes?' })).not.toBeInTheDocument();
    // The field is still there with what was typed in it.
    expect(screen.getByLabelText('Email address')).toHaveValue('a');
  });

  it('closes the form once the discard is confirmed', () => {
    const { onClose, dialog } = renderDialog();

    fireEvent.change(screen.getByLabelText('Email address'), { target: { value: 'a' } });
    pressEscape(dialog);
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));

    expect(onClose).toHaveBeenCalled();
  });

  it('asks nothing of a confirmation dialog, which has nothing to lose', () => {
    // Every delete dialog in the app is a `FormDialog` with no fields in it.
    const { onClose, dialog } = renderDialog({ withField: false });

    pressEscape(dialog);

    expect(onClose).toHaveBeenCalled();
  });

  it('does not take a press on the scrim, typed into or not', () => {
    const { onClose, dialog } = renderDialog();

    fireEvent.click(dialog);

    expect(onClose).not.toHaveBeenCalled();
  });
});
