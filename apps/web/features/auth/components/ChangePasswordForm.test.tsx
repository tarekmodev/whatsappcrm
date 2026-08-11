import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { ChangePasswordForm } from './ChangePasswordForm';

// `fireEvent` rather than `user-event`: the repo does not carry that package.
// The mock is typed against the action's real signature, so a test cannot go on
// passing while the action it stands in for changes shape.
const changePasswordAction = vi.fn<(input: unknown) => Promise<ActionResult<undefined>>>();

vi.mock('../auth.actions', () => ({
  changePasswordAction: (input: unknown) => changePasswordAction(input),
}));

const EMAIL = 'agent@acme.test';
const CURRENT = 'the-old-passphrase';
const NEXT = 'a-perfectly-fine-passphrase';

function renderForm() {
  return render(
    <ToastProvider>
      <ChangePasswordForm email={EMAIL} />
    </ToastProvider>,
  );
}

function fillAndSubmit(current: string, next: string, confirmation = next): void {
  fireEvent.change(fieldByLabel(content.auth.currentPasswordLabel), {
    target: { value: current },
  });
  fireEvent.change(fieldByLabel(content.auth.newPasswordLabel), { target: { value: next } });
  fireEvent.change(fieldByLabel(content.auth.confirmPasswordLabel), {
    target: { value: confirmation },
  });
  fireEvent.click(screen.getByRole('button', { name: content.auth.changeSubmit }));
}

describe('ChangePasswordForm', () => {
  beforeEach(() => {
    changePasswordAction.mockReset();
    changePasswordAction.mockResolvedValue({ status: 'success', data: undefined });
  });

  it('sends the current and the new password under the contract’s names', async () => {
    renderForm();

    fillAndSubmit(CURRENT, NEXT);

    await waitFor(() => {
      expect(changePasswordAction).toHaveBeenCalledWith({
        currentPassword: CURRENT,
        newPassword: NEXT,
      });
    });
  });

  it('says the other sessions were signed out and that this one was not', async () => {
    renderForm();

    fillAndSubmit(CURRENT, NEXT);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.changeDoneHeading }),
      ).toBeInTheDocument();
    });

    // TAR-35: a change revokes every session *except* the caller's, which is the
    // opposite of a reset — so the copy has to be explicit about which.
    expect(screen.getByText(content.auth.changeDoneBody)).toBeInTheDocument();

    // Inside `waitFor`: focus moves in a passive effect, which is committed after
    // the node is in the DOM, so sampling it the instant the heading appears is a
    // race rather than an assertion.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: content.auth.changeDoneHeading }),
      );
    });
  });

  it('will not submit without the current password', () => {
    renderForm();

    fillAndSubmit('', NEXT);

    expect(screen.getByText(content.auth.currentPasswordRequiredError)).toBeInTheDocument();
    expect(changePasswordAction).not.toHaveBeenCalled();
  });

  it('will not submit a confirmation that does not match', () => {
    renderForm();

    fillAndSubmit(CURRENT, NEXT, `${NEXT}!`);

    expect(screen.getByText(content.auth.passwordMismatchError)).toBeInTheDocument();
    expect(changePasswordAction).not.toHaveBeenCalled();
  });

  it('shows a wrong current password inline and keeps everything the user typed', async () => {
    changePasswordAction.mockResolvedValue({
      status: 'error',
      message: 'The current password is incorrect.',
      requestId: null,
    });

    renderForm();
    fillAndSubmit(CURRENT, NEXT);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('The current password is incorrect.');
    });

    // A failed submit must never make somebody retype a long passphrase.
    expect(fieldByLabel(content.auth.newPasswordLabel)).toHaveValue(NEXT);
    expect(fieldByLabel(content.auth.confirmPasswordLabel)).toHaveValue(NEXT);
  });

  it('carries the account address for a password manager to attach the secret to', () => {
    renderForm();

    expect(screen.getByLabelText(content.auth.signedInAs)).toHaveValue(EMAIL);
  });

  it('labels the fields so a password manager cannot confuse old with new', () => {
    renderForm();

    expect(fieldByLabel(content.auth.currentPasswordLabel)).toHaveAttribute(
      'autocomplete',
      'current-password',
    );
    expect(fieldByLabel(content.auth.newPasswordLabel)).toHaveAttribute(
      'autocomplete',
      'new-password',
    );
  });
});
