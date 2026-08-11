import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import { ForgotPasswordForm } from './ForgotPasswordForm';

// `fireEvent` rather than `user-event`: the repo does not carry that package.
// The mock is typed against the action's real signature, so a test cannot go on
// passing while the action it stands in for changes shape.
const requestPasswordResetAction =
  vi.fn<(input: unknown) => Promise<ActionResult<{ email: string }>>>();

vi.mock('../auth.actions', () => ({
  requestPasswordResetAction: (input: unknown) => requestPasswordResetAction(input),
}));

function submitWith(email: string): void {
  fireEvent.change(fieldByLabel(content.auth.emailLabel), { target: { value: email } });
  fireEvent.click(screen.getByRole('button', { name: content.auth.forgotSubmit }));
}

describe('ForgotPasswordForm', () => {
  beforeEach(() => {
    requestPasswordResetAction.mockReset();
    requestPasswordResetAction.mockResolvedValue({
      status: 'success',
      data: { email: 'agent@acme.test' },
    });
  });

  it('validates the address before spending a round trip on it', () => {
    render(<ForgotPasswordForm />);

    submitWith('not-an-address');

    expect(screen.getByText(content.form.invalidEmailError)).toBeInTheDocument();
    expect(requestPasswordResetAction).not.toHaveBeenCalled();
  });

  it('sends the trimmed address and confirms without saying whether it exists', async () => {
    render(<ForgotPasswordForm />);

    submitWith('  agent@acme.test  ');

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.forgotSentHeading }),
      ).toBeInTheDocument();
    });

    expect(requestPasswordResetAction).toHaveBeenCalledWith({ email: 'agent@acme.test' });
    // The whole point of the screen: it reports what *would* happen, conditionally,
    // and never confirms that the address belongs to an account.
    expect(screen.getByText(/^If an account exists for agent@acme\.test/)).toBeInTheDocument();
  });

  it('gives the confirmation heading focus, so focus is not lost with the form', async () => {
    render(<ForgotPasswordForm />);

    submitWith('agent@acme.test');

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: content.auth.forgotSentHeading }),
      );
    });
  });

  it('keeps the typed address when the user goes back to try another', async () => {
    render(<ForgotPasswordForm />);

    submitWith('agent@acme.test');

    await waitFor(() => {
      expect(
        screen.getByRole('button', { name: content.auth.forgotSendAgain }),
      ).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: content.auth.forgotSendAgain }));

    expect(fieldByLabel(content.auth.emailLabel)).toHaveValue('agent@acme.test');
  });

  it('reports a transport failure inline and keeps the form', async () => {
    requestPasswordResetAction.mockResolvedValue({
      status: 'error',
      message: content.auth.genericFailure,
      requestId: 'req-1',
    });

    render(<ForgotPasswordForm />);
    submitWith('agent@acme.test');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(content.auth.genericFailure);
    });

    expect(fieldByLabel(content.auth.emailLabel)).toHaveValue('agent@acme.test');
  });
});
