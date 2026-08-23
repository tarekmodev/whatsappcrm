import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  LIFECYCLE_POLICY,
  SIGNUP_POLICY,
  type SignupAcceptedResponse,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { SignupSentCard } from './SignupSentCard';

/**
 * The card between the form and the inbox, and the only outcome card in this
 * folder with an action that can fail where it stands.
 *
 * What these are really about is the resend ceiling: `SIGNUP_POLICY` bounds it on
 * the pending row itself, and a console that offered a fourth press would be
 * offering a button whose only possible answer is a refusal.
 */

const transport = vi.hoisted(() => ({ resendSignupVerification: vi.fn() }));

vi.mock('@/lib/api/auth-browser', () => ({
  login: vi.fn(),
  lookupInvite: vi.fn(),
  acceptInvite: vi.fn(),
  requestSignup: vi.fn(),
  verifySignup: vi.fn(),
  resendSignupVerification: transport.resendSignupVerification,
  checkSlugAvailability: vi.fn(),
}));

const EMAIL = 'amina@northwind.example';

const ACCEPTED = {
  email: EMAIL,
  expiresAt: '2026-08-24T10:00:00.000Z',
} satisfies SignupAcceptedResponse;

const onUseAnotherAddress = vi.fn();

function renderCard() {
  return render(<SignupSentCard accepted={ACCEPTED} onUseAnotherAddress={onUseAnotherAddress} />);
}

function resend(): void {
  fireEvent.click(screen.getByRole('button', { name: content.auth.signupResend }));
}

beforeEach(() => {
  vi.clearAllMocks();
  transport.resendSignupVerification.mockResolvedValue(ACCEPTED);
});

describe('SignupSentCard', () => {
  it('names the address and how long the link lasts, and takes focus from the form that unmounted', () => {
    renderCard();

    const heading = screen.getByRole('heading', { name: content.auth.signupSentHeading });

    // The control the user just pressed has gone with the form; without this,
    // focus falls to `<body>` and nothing is announced.
    expect(heading).toHaveFocus();
    expect(screen.getByText(content.auth.signupSentBody(EMAIL))).toBeInTheDocument();
    // Read off `LIFECYCLE_POLICY`, so the copy cannot promise a window the API
    // does not honour.
    expect(
      screen.getByText(
        content.auth.signupSentExpiry(LIFECYCLE_POLICY.signupTokenTtlMs / 3_600_000),
      ),
    ).toBeInTheDocument();
  });

  it('sends the link again and says so, in place of the spam-folder hint', async () => {
    renderCard();

    resend();

    expect(await screen.findByText(content.auth.signupResendSent)).toBeInTheDocument();
    expect(transport.resendSignupVerification).toHaveBeenCalledWith({ email: EMAIL });
    // One line at a time: the two say the same thing at two moments, and both at
    // once makes the card look like it is arguing with itself.
    expect(screen.queryByText(content.auth.signupSentHint)).not.toBeInTheDocument();
  });

  it('stops at the ceiling the contract sets, and explains what a fourth copy would not fix', async () => {
    renderCard();

    for (let attempt = 0; attempt < SIGNUP_POLICY.resendsPerSignup; attempt += 1) {
      resend();
      await waitFor(() => {
        expect(transport.resendSignupVerification).toHaveBeenCalledTimes(attempt + 1);
      });
    }

    expect(await screen.findByText(content.auth.signupResendExhausted)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.auth.signupResend }),
    ).not.toBeInTheDocument();
    // The remaining way out is now the primary one, because it is the only one.
    expect(
      screen.getByRole('button', { name: content.auth.signupUseAnotherAddress }),
    ).toBeInTheDocument();
  });

  it('reports a throttled resend in resend’s own words rather than the sign-in lockout’s', async () => {
    transport.resendSignupVerification.mockRejectedValue(
      new ApiRequestError(429, 'rate_limited', 'Server-side message', 'request-1'),
    );
    renderCard();

    resend();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(content.auth.signupResendRateLimitedError);
    expect(alert).not.toHaveTextContent('Server-side message');
    // A refusal is not a send: the button stays, because waiting is the fix.
    expect(screen.getByRole('button', { name: content.auth.signupResend })).toBeInTheDocument();
  });

  it('hands back to the form for somebody who mistyped their address', () => {
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: content.auth.signupUseAnotherAddress }));

    expect(onUseAnotherAddress).toHaveBeenCalled();
  });
});
