import { StrictMode } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import type { ActionResult } from '@/lib/actions/result';
import type { ResetOutcome } from '../auth.actions';
import { ResetPasswordForm } from './ResetPasswordForm';

// `fireEvent` rather than `user-event`: the repo does not carry that package.
// The mock is typed against the action's real signature, so a test cannot go on
// passing while the action it stands in for changes shape.
const confirmPasswordResetAction = vi.fn<(input: unknown) => Promise<ActionResult<ResetOutcome>>>();

vi.mock('../auth.actions', () => ({
  confirmPasswordResetAction: (input: unknown) => confirmPasswordResetAction(input),
}));

const TOKEN = 'a-256-bit-token';
const NEW_PASSWORD = 'a-perfectly-fine-passphrase';

function openLinkWith(fragment: string): void {
  window.history.replaceState(null, '', `/reset-password${fragment}`);
}

function fillAndSubmit(password: string, confirmation = password): void {
  fireEvent.change(fieldByLabel(content.auth.newPasswordLabel), {
    target: { value: password },
  });
  fireEvent.change(fieldByLabel(content.auth.confirmPasswordLabel), {
    target: { value: confirmation },
  });
  fireEvent.click(screen.getByRole('button', { name: content.auth.resetSubmit }));
}

describe('ResetPasswordForm', () => {
  beforeEach(() => {
    confirmPasswordResetAction.mockReset();
    confirmPasswordResetAction.mockResolvedValue({ status: 'success', data: { kind: 'reset' } });
  });

  it('reads the token from the fragment and scrubs it from the address bar', async () => {
    openLinkWith(`#token=${TOKEN}`);
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    // A live credential must not survive in the URL for a screenshot or the next
    // person to glance at the screen.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/reset-password');
  });

  it('submits the token from the fragment with the new password', async () => {
    openLinkWith(`#token=${TOKEN}`);
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(confirmPasswordResetAction).toHaveBeenCalledWith({
        token: TOKEN,
        password: NEW_PASSWORD,
      });
    });
  });

  it('tells the user their other sessions are gone once the reset lands', async () => {
    openLinkWith(`#token=${TOKEN}`);
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.resetDoneHeading }),
      ).toBeInTheDocument();
    });

    // TAR-35 acceptance criterion: the user is told the reset invalidated every
    // session, because the backend did exactly that.
    expect(screen.getByText(content.auth.resetSessionsRevokedNotice)).toBeInTheDocument();

    // Inside `waitFor`: focus moves in a passive effect, committed after the node
    // reaches the DOM, so sampling it the instant the heading appears is a race.
    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByRole('heading', { name: content.auth.resetDoneHeading }),
      );
    });
  });

  it('refuses to submit a confirmation that does not match', async () => {
    openLinkWith(`#token=${TOKEN}`);
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    fillAndSubmit(NEW_PASSWORD, `${NEW_PASSWORD}!`);

    expect(screen.getByText(content.auth.passwordMismatchError)).toBeInTheDocument();
    expect(confirmPasswordResetAction).not.toHaveBeenCalled();
  });

  it('offers a new link, not a retry, when the API says the token is dead', async () => {
    confirmPasswordResetAction.mockResolvedValue({
      status: 'success',
      data: { kind: 'link_unusable', message: 'This password reset link has expired.' },
    });

    openLinkWith(`#token=${TOKEN}`);
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.linkUnusableHeading }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText('This password reset link has expired.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.auth.requestNewLink })).toBeInTheDocument();
    // The form is gone: there is nothing left on it worth submitting.
    expect(
      screen.queryByRole('button', { name: content.auth.resetSubmit }),
    ).not.toBeInTheDocument();
  });

  it('picks up a second link opened in the same tab', async () => {
    // Two reset emails differ only by fragment, so the newer link is a
    // same-document navigation: no reload and no remount. Somebody told their
    // first link is dead and then clicking the second must not be stranded on
    // the dead-link screen.
    confirmPasswordResetAction.mockResolvedValue({
      status: 'success',
      data: { kind: 'link_unusable', message: 'This password reset link has expired.' },
    });

    openLinkWith('#token=the-stale-one');
    render(<ResetPasswordForm />);

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.linkUnusableHeading }),
      ).toBeInTheDocument();
    });

    // The newer email arrives in the same tab.
    confirmPasswordResetAction.mockResolvedValue({ status: 'success', data: { kind: 'reset' } });
    window.location.hash = `#token=${TOKEN}`;
    fireEvent(window, new HashChangeEvent('hashchange'));

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    // A fresh form for a fresh token, not the previous one's leftovers.
    expect(fieldByLabel(content.auth.newPasswordLabel)).toHaveValue('');

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(confirmPasswordResetAction).toHaveBeenLastCalledWith({
        token: TOKEN,
        password: NEW_PASSWORD,
      });
    });
  });

  it('survives a remount after the fragment has been scrubbed', async () => {
    // Regression: the scrub destroys the only copy of the token, so a second
    // mount used to read an empty fragment and declare the link broken. Strict
    // Mode does exactly this in development, and an error-boundary reset or a
    // Suspense retry can do it in production.
    openLinkWith(`#token=${TOKEN}`);

    render(
      <StrictMode>
        <ResetPasswordForm />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(fieldByLabel(content.auth.newPasswordLabel)).toBeInTheDocument();
    });

    expect(window.location.hash).toBe('');
    expect(
      screen.queryByRole('heading', { name: content.auth.linkUnusableHeading }),
    ).not.toBeInTheDocument();

    fillAndSubmit(NEW_PASSWORD);

    await waitFor(() => {
      expect(confirmPasswordResetAction).toHaveBeenCalledWith({
        token: TOKEN,
        password: NEW_PASSWORD,
      });
    });
  });

  it('explains a link that arrived without a token, and never renders the form', async () => {
    openLinkWith('');

    // A fresh module registry stands in for a fresh document: `useLinkToken`
    // remembers the token for the life of the document it arrived in, so this has
    // to be a new one rather than a remount of the link the tests above opened.
    vi.resetModules();
    const { ResetPasswordForm: FreshDocument } = await import('./ResetPasswordForm');

    render(<FreshDocument />);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.linkUnusableHeading }),
      ).toBeInTheDocument();
    });

    expect(screen.getByText(content.auth.linkIncompleteBody)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.auth.resetSubmit }),
    ).not.toBeInTheDocument();
  });
});
