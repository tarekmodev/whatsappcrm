import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AUTH_POLICY, type SessionPrincipal } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { LoginForm } from './LoginForm';

/**
 * The sign-in screen's behaviour, exercised through the real request and
 * error-mapping modules with only the transport faked — so what these assert is
 * "this API answer produces this screen", not "this mock was called".
 *
 * `fireEvent` rather than `user-event`: the repo does not carry that package.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const transport = vi.hoisted(() => ({ login: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

vi.mock('@/lib/api/auth', () => ({
  login: transport.login,
  lookupInvite: vi.fn(),
  acceptInvite: vi.fn(),
}));

const PRINCIPAL = {
  userId: '0192f001-0000-7000-8000-000000000101',
  tenantId: '0192f000-0000-7000-8000-000000000001',
  email: 'amina@northwind.example',
  displayName: 'Amina Haddad',
  role: 'agent',
  permissions: [],
  teamIds: [],
  sessionId: '0192f003-0000-7000-8000-000000000301',
  expiresAt: '2026-08-12T10:00:00.000Z',
} satisfies SessionPrincipal;

const REDIRECT_TO = '/inbox';

function renderForm() {
  return render(
    <ToastProvider>
      <LoginForm redirectTo={REDIRECT_TO} />
    </ToastProvider>,
  );
}

/**
 * `exact: false` because a required field's label carries a trailing asterisk,
 * and `selector` because "Password" is also a substring of the visibility
 * toggle's accessible name.
 */
function field(label: string): HTMLElement {
  return screen.getByLabelText(label, { exact: false, selector: 'input' });
}

function fill(label: string, value: string): void {
  fireEvent.change(field(label), { target: { value } });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.auth.signInSubmit }));
}

function apiError(status: number, code: string): ApiRequestError {
  return new ApiRequestError(status, code, 'Server-side message', 'request-1');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('LoginForm', () => {
  it('refuses to submit an empty form and puts focus on the first invalid field', () => {
    renderForm();

    submit();

    expect(transport.login).not.toHaveBeenCalled();
    expect(screen.getAllByText(content.form.requiredFieldError)).toHaveLength(2);
    expect(field(content.auth.emailLabel)).toHaveFocus();
  });

  it('rejects a malformed address before the round trip', () => {
    renderForm();

    fill(content.auth.emailLabel, 'not-an-address');
    fill(content.auth.passwordLabel, 'correct horse battery');
    submit();

    expect(transport.login).not.toHaveBeenCalled();
    expect(screen.getByText(content.form.invalidEmailError)).toBeInTheDocument();
  });

  it('signs in and sends the user where the page said, without exposing a token', async () => {
    transport.login.mockResolvedValue(PRINCIPAL);
    renderForm();

    fill(content.auth.emailLabel, ' amina@northwind.example ');
    fill(content.auth.passwordLabel, 'correct horse battery');
    submit();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith(REDIRECT_TO);
    });

    // Trimmed, because a copied address carries a trailing space more often than not.
    expect(transport.login).toHaveBeenCalledWith({
      email: 'amina@northwind.example',
      password: 'correct horse battery',
    });
    // The server render behind the redirect has to see the new cookie.
    expect(router.refresh).toHaveBeenCalled();
    expect(screen.getByText(content.auth.signInSuccess(PRINCIPAL.displayName))).toBeInTheDocument();
  });

  it('reports a rejected credential without saying which half was wrong, and keeps the input', async () => {
    transport.login.mockRejectedValue(apiError(401, 'invalid_credentials'));
    renderForm();

    fill(content.auth.emailLabel, 'amina@northwind.example');
    fill(content.auth.passwordLabel, 'wrong password');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      content.auth.invalidCredentialsError,
    );
    // A failed submit must never make somebody retype their address.
    expect(field(content.auth.emailLabel)).toHaveValue('amina@northwind.example');
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('turns the lockout 429 into the wait the contract specifies', async () => {
    transport.login.mockRejectedValue(apiError(429, 'rate_limited'));
    renderForm();

    fill(content.auth.emailLabel, 'amina@northwind.example');
    fill(content.auth.passwordLabel, 'wrong password');
    submit();

    const minutes = AUTH_POLICY.loginLockoutMs / 60_000;

    expect(await screen.findByRole('alert')).toHaveTextContent(
      content.auth.lockedOutError(minutes),
    );
  });

  it('shows a neutral line rather than the API’s own message for an unmapped failure', async () => {
    transport.login.mockRejectedValue(apiError(500, 'internal_error'));
    renderForm();

    fill(content.auth.emailLabel, 'amina@northwind.example');
    fill(content.auth.passwordLabel, 'correct horse battery');
    submit();

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent(content.auth.signInFailedError);
    expect(alert).not.toHaveTextContent('Server-side message');
  });

  it('lets the user read the password back', () => {
    renderForm();

    const password = field(content.auth.passwordLabel);

    expect(password).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: content.auth.showPasswordAria }));

    expect(password).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: content.auth.hidePasswordAria })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});
