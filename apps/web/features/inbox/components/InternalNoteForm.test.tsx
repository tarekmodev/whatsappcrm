import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { InternalNoteForm } from './InternalNoteForm';

const addInternalNoteAction = vi.fn();

vi.mock('@/features/inbox/inbox.actions', () => ({
  addInternalNoteAction: (...args: unknown[]) => addInternalNoteAction(...args) as unknown,
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';

function renderForm() {
  return render(
    <ToastProvider>
      <InternalNoteForm conversationId={CONVERSATION_ID} />
    </ToastProvider>,
  );
}

beforeEach(() => {
  addInternalNoteAction.mockReset();
  addInternalNoteAction.mockResolvedValue({ status: 'success', data: undefined });
});

describe('InternalNoteForm', () => {
  it('sends the trimmed note and clears the field on success', async () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.notes.addLabel), {
      target: { value: '  Chased accounting.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: content.notes.addSubmit }));

    await waitFor(() => {
      expect(addInternalNoteAction).toHaveBeenCalledWith(CONVERSATION_ID, {
        body: 'Chased accounting.',
      });
    });

    await waitFor(() => {
      expect(fieldByLabel(content.notes.addLabel)).toHaveValue('');
    });
    expect(screen.getByText(content.notes.addSuccess)).toBeInTheDocument();
  });

  it('refuses an empty note where the agent can still fix it, without a round trip', () => {
    renderForm();

    fireEvent.change(fieldByLabel(content.notes.addLabel), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: content.notes.addSubmit }));

    expect(screen.getByText(content.notes.bodyRequiredError)).toBeInTheDocument();
    expect(addInternalNoteAction).not.toHaveBeenCalled();
  });

  it('keeps what was typed when the action fails', async () => {
    addInternalNoteAction.mockResolvedValue({
      status: 'error',
      message: content.form.genericSubmitError,
      requestId: null,
    });

    renderForm();

    fireEvent.change(fieldByLabel(content.notes.addLabel), { target: { value: 'Worth keeping.' } });
    fireEvent.click(screen.getByRole('button', { name: content.notes.addSubmit }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(content.form.genericSubmitError);
    });

    // Nobody should have to write a note twice.
    expect(fieldByLabel(content.notes.addLabel)).toHaveValue('Worth keeping.');
  });

  it('caps the field at the length the contract enforces', () => {
    renderForm();

    // The API would answer 422; the control refuses the keystroke instead.
    expect(fieldByLabel(content.notes.addLabel)).toHaveAttribute('maxLength', '8000');
  });
});
