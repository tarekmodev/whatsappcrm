import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SignupAcceptedResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { SignupForm } from './SignupForm';

/**
 * Creating a workspace, exercised through the real request and error-mapping
 * modules with only the transport faked — so what these assert is "this API
 * answer produces this screen", not "this mock was called".
 *
 * Real timers throughout, including across the availability debounce: the pause
 * before a check leaves is part of the behaviour under test, and faking it would
 * assert the schedule rather than the effect.
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

const transport = vi.hoisted(() => ({
  requestSignup: vi.fn(),
  checkSlugAvailability: vi.fn(),
}));

vi.mock('@/lib/api/auth-browser', () => ({
  login: vi.fn(),
  lookupInvite: vi.fn(),
  acceptInvite: vi.fn(),
  requestSignup: transport.requestSignup,
  verifySignup: vi.fn(),
  resendSignupVerification: vi.fn(),
  checkSlugAvailability: transport.checkSlugAvailability,
}));

const PLATFORM_HOST = 'app.example.com';
const SLUG = 'northwind';
const WORKSPACE_NAME = 'Northwind Support';
const ADMIN_NAME = 'Amina Haddad';
const EMAIL = 'amina@northwind.example';
const PASSWORD = 'a-perfectly-fine-passphrase';

const ACCEPTED = {
  email: EMAIL,
  expiresAt: '2026-08-24T10:00:00.000Z',
} satisfies SignupAcceptedResponse;

function renderForm() {
  return render(<SignupForm platformHost={PLATFORM_HOST} />);
}

function fill(label: string, value: string): void {
  fireEvent.change(fieldByLabel(label), { target: { value } });
}

/** Everything the API needs, so a test can be about the one field it changes. */
function fillEveryField(overrides: { slug?: string } = {}): void {
  fill(content.auth.signupWorkspaceNameLabel, WORKSPACE_NAME);
  fill(content.auth.signupSlugLabel, overrides.slug ?? SLUG);
  fill(content.auth.signupNameLabel, ADMIN_NAME);
  fill(content.auth.emailLabel, EMAIL);
  fill(content.auth.signupPasswordLabel, PASSWORD);
  fill(content.auth.confirmPasswordLabel, PASSWORD);
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.auth.signupSubmit }));
}

function apiError(status: number, code: string): ApiRequestError {
  return new ApiRequestError(status, code, 'Server-side message', 'request-1');
}

beforeEach(() => {
  vi.clearAllMocks();
  // The default for every test that is not about the check itself. Without one,
  // the hook would resolve `undefined` and every case would carry an unrelated
  // failed lookup.
  transport.checkSlugAvailability.mockResolvedValue({ slug: SLUG, available: true });
});

describe('SignupForm', () => {
  it('refuses to submit an empty form, and says what is missing on each field', () => {
    renderForm();

    submit();

    expect(transport.requestSignup).not.toHaveBeenCalled();
    expect(screen.getByText(content.auth.signupWorkspaceNameRequiredError)).toBeInTheDocument();
    expect(screen.getByText(content.auth.signupSlugRequiredError)).toBeInTheDocument();
    expect(screen.getByText(content.auth.signupNameRequiredError)).toBeInTheDocument();
    expect(screen.getByText(content.form.requiredFieldError)).toBeInTheDocument();
    expect(screen.getByText(content.auth.passwordRequiredError)).toBeInTheDocument();
  });

  it('shows the address it is about to create, on the host it was served from', () => {
    renderForm();

    fill(content.auth.signupSlugLabel, SLUG);

    // Not a hardcoded production domain: the preview is composed against the host
    // the page arrived on, which is what makes it true on localhost too.
    expect(screen.getByText(`${SLUG}.${PLATFORM_HOST}`)).toBeInTheDocument();
  });

  it('lower-cases the address as it is typed rather than refusing a capital letter', () => {
    renderForm();

    fill(content.auth.signupSlugLabel, 'NorthWind');

    expect(fieldByLabel(content.auth.signupSlugLabel)).toHaveValue('northwind');
    expect(screen.queryByText(content.auth.signupSlugInvalidError)).not.toBeInTheDocument();
  });

  it('waits for a pause in the typing before spending a check', async () => {
    renderForm();

    fill(content.auth.signupSlugLabel, SLUG);

    // The keystroke itself buys nothing; `SIGNUP_POLICY.slugChecksPerIpPerMinute`
    // is a backstop and the pacing is the console's job.
    expect(transport.checkSlugAvailability).not.toHaveBeenCalled();
    expect(await screen.findByText(content.auth.signupSlugAvailable)).toBeInTheDocument();
    expect(transport.checkSlugAvailability).toHaveBeenCalledTimes(1);
    expect(transport.checkSlugAvailability).toHaveBeenCalledWith(SLUG, expect.any(AbortSignal));
  });

  it('never asks about an address the API would refuse on shape alone', async () => {
    renderForm();

    // Two characters and then a trailing hyphen: `TenantSlugSchema` refuses both,
    // and a check spent on either is one taken off a rate limit for nothing.
    fill(content.auth.signupSlugLabel, 'no');
    fill(content.auth.signupSlugLabel, 'north-');
    fill(content.auth.signupSlugLabel, SLUG);

    expect(await screen.findByText(content.auth.signupSlugAvailable)).toBeInTheDocument();
    // Once, for the only value worth asking about.
    expect(transport.checkSlugAvailability).toHaveBeenCalledTimes(1);
    expect(transport.checkSlugAvailability).toHaveBeenCalledWith(SLUG, expect.any(AbortSignal));
  });

  it('refuses a taken address before anybody goes to check their inbox', async () => {
    transport.checkSlugAvailability.mockResolvedValue({ slug: SLUG, available: false });
    renderForm();

    fillEveryField();

    // Twice: once as the field's own error, which is what makes the control
    // invalid, and once in the live region, which is what announces it to
    // somebody who is not looking at that field.
    expect(await screen.findAllByText(content.auth.signupSlugTakenError)).toHaveLength(2);

    submit();

    expect(transport.requestSignup).not.toHaveBeenCalled();
  });

  it('still submits when the availability check itself could not run', async () => {
    // The check is a courtesy and `POST /signup` is the authority; a console that
    // blocked the button because a convenience endpoint was down would be worse
    // than one that never had it.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    transport.checkSlugAvailability.mockRejectedValue(apiError(503, 'upstream_error'));
    transport.requestSignup.mockResolvedValue(ACCEPTED);
    renderForm();

    fillEveryField();

    expect(await screen.findByText(content.auth.signupSlugCheckUnavailable)).toBeInTheDocument();

    submit();

    await waitFor(() => {
      expect(transport.requestSignup).toHaveBeenCalled();
    });
  });

  it('sends the trimmed values and the visitor’s own time zone, then says where to look', async () => {
    transport.requestSignup.mockResolvedValue(ACCEPTED);
    renderForm();

    fill(content.auth.signupWorkspaceNameLabel, ` ${WORKSPACE_NAME} `);
    fill(content.auth.signupSlugLabel, SLUG);
    fill(content.auth.signupNameLabel, ` ${ADMIN_NAME} `);
    fill(content.auth.emailLabel, ` ${EMAIL} `);
    fill(content.auth.signupPasswordLabel, PASSWORD);
    fill(content.auth.confirmPasswordLabel, PASSWORD);
    submit();

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.auth.signupSentHeading }),
      ).toBeInTheDocument();
    });

    // Trimmed, because a pasted address carries a trailing space more often than
    // not — and the time zone, which is the tenant's own from the first day
    // rather than the provisioning default nobody chose.
    expect(transport.requestSignup).toHaveBeenCalledWith({
      email: EMAIL,
      password: PASSWORD,
      adminName: ADMIN_NAME,
      tenantName: WORKSPACE_NAME,
      slug: SLUG,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    // Names the address without confirming anything was found there.
    expect(screen.getByText(content.auth.signupSentBody(EMAIL))).toBeInTheDocument();
  });

  it('puts a submit-time conflict on the field that caused it, not in a banner above six others', async () => {
    transport.requestSignup.mockRejectedValue(apiError(409, 'conflict'));
    renderForm();

    fillEveryField();
    submit();

    await waitFor(() => {
      expect(fieldByLabel(content.auth.signupSlugLabel)).toHaveFocus();
    });
    expect(fieldByLabel(content.auth.signupSlugLabel)).toHaveAttribute('aria-invalid', 'true');
    // Not a form-level failure: everything else the visitor typed was fine.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('explains a deployment that does not create workspaces from a form', async () => {
    // `SIGNUP_ENABLED=false` answers `not_found`, never `forbidden`.
    transport.requestSignup.mockRejectedValue(apiError(404, 'not_found'));
    renderForm();

    fillEveryField();
    submit();

    expect(
      await screen.findByRole('heading', { name: content.auth.signupDisabledHeading }),
    ).toBeInTheDocument();
    // The form is gone: nothing typed into it could ever be accepted here.
    expect(
      screen.queryByRole('button', { name: content.auth.signupSubmit }),
    ).not.toBeInTheDocument();
  });

  it('uses signup’s own wording for a throttled attempt, not the sign-in lockout’s', async () => {
    transport.requestSignup.mockRejectedValue(apiError(429, 'rate_limited'));
    renderForm();

    fillEveryField();
    submit();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(content.auth.signupRateLimitedError);
    // The shared mapping's 429 is a login lockout and talks about unlocking an
    // account, which there is not one of yet.
    expect(alert).not.toHaveTextContent('failed sign-in attempts');
  });

  it('shows a neutral line rather than the API’s own message, and keeps every field', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    transport.requestSignup.mockRejectedValue(apiError(500, 'internal_error'));
    renderForm();

    fillEveryField();
    submit();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(content.auth.signupFailedError);
    expect(alert).not.toHaveTextContent('Server-side message');
    // A failed submit must never make somebody retype six fields.
    expect(fieldByLabel(content.auth.signupWorkspaceNameLabel)).toHaveValue(WORKSPACE_NAME);
    expect(fieldByLabel(content.auth.signupSlugLabel)).toHaveValue(SLUG);
    expect(fieldByLabel(content.auth.emailLabel)).toHaveValue(EMAIL);
  });

  it('offers the way back for somebody who already has a workspace', () => {
    renderForm();

    expect(screen.getByRole('link', { name: content.auth.backToSignIn })).toHaveAttribute(
      'href',
      '/login',
    );
  });
});
