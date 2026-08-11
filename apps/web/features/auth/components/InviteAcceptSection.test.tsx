import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  AUTH_POLICY,
  type InvitePreviewResponse,
  type SessionPrincipal,
} from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { InviteAcceptSection } from './InviteAcceptSection';

/**
 * Every outcome the invite link can have, from the fragment upwards. The token
 * only ever exists in `location.hash`, so these set it the way the emailed link
 * does.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const transport = vi.hoisted(() => ({ lookupInvite: vi.fn(), acceptInvite: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

vi.mock('@/lib/api/auth', () => ({
  login: vi.fn(),
  lookupInvite: transport.lookupInvite,
  acceptInvite: transport.acceptInvite,
}));

const TOKEN = 'a-256-bit-token';

const PREVIEW = {
  email: 'amina@northwind.example',
  role: 'agent',
  expiresAt: '2026-08-18T10:00:00.000Z',
  tenantName: 'Northwind Support',
  invitedByName: 'Yusuf Karim',
} satisfies InvitePreviewResponse;

const PRINCIPAL = {
  userId: '0192f001-0000-7000-8000-000000000101',
  tenantId: '0192f000-0000-7000-8000-000000000001',
  email: PREVIEW.email,
  displayName: 'Amina Haddad',
  role: 'agent',
  permissions: [],
  teamIds: [],
  sessionId: '0192f003-0000-7000-8000-000000000301',
  expiresAt: '2026-08-12T10:00:00.000Z',
} satisfies SessionPrincipal;

function renderSection() {
  return render(
    <ToastProvider>
      <InviteAcceptSection />
    </ToastProvider>,
  );
}

/**
 * `exact: false` because a required field's label carries a trailing asterisk,
 * and `selector` so a label that is also a substring of a button's accessible
 * name cannot match two things.
 */
function fill(label: string, value: string): void {
  fireEvent.change(screen.getByLabelText(label, { exact: false, selector: 'input' }), {
    target: { value },
  });
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: content.auth.inviteSubmit }));
}

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = `#token=${TOKEN}`;
});

describe('InviteAcceptSection', () => {
  it('announces the lookup once and reserves the shape of what is coming', () => {
    // Never settles: the loading state is what is under test.
    transport.lookupInvite.mockReturnValue(new Promise(() => undefined));
    renderSection();

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.auth.inviteLoading);
    // A skeleton, not a spinner and not a blank card.
    expect(
      screen.queryByRole('button', { name: content.auth.inviteSubmit }),
    ).not.toBeInTheDocument();
  });

  it('explains a link that arrived without its fragment', async () => {
    window.location.hash = '';
    renderSection();

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteMissingTokenHeading }),
    ).toBeInTheDocument();
    expect(transport.lookupInvite).not.toHaveBeenCalled();
    // Nothing to retry, so the only action offered is the one that still works.
    expect(screen.getByRole('link', { name: content.auth.goToSignIn })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('offers a way forward when the invitation is expired, used or withdrawn', async () => {
    transport.lookupInvite.mockRejectedValue(
      new ApiRequestError(410, 'token_invalid', 'Server-side message', null),
    );
    renderSection();

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteDeadLinkHeading }),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.auth.goToSignIn })).toBeInTheDocument();
  });

  it('shows who invited them, to what, and lets them retry a failed lookup', async () => {
    transport.lookupInvite.mockRejectedValueOnce(new Error('network down'));
    transport.lookupInvite.mockResolvedValueOnce(PREVIEW);
    renderSection();

    fireEvent.click(await screen.findByRole('button', { name: content.common.retry }));

    expect(
      await screen.findByText(content.auth.invitedByTo(PREVIEW.invitedByName, PREVIEW.tenantName)),
    ).toBeInTheDocument();
    // Display-only: the invitation is bound to this address on the server.
    expect(screen.getByText(PREVIEW.email)).toBeInTheDocument();
    expect(screen.getByText(content.roles.agent)).toBeInTheDocument();
  });

  it('enforces the contract’s password floor before sending anything', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    renderSection();

    await screen.findByRole('button', { name: content.auth.inviteSubmit });

    fill(content.auth.inviteDisplayNameLabel, 'Amina Haddad');
    fill(content.auth.invitePasswordLabel, 'short');
    submit();

    expect(transport.acceptInvite).not.toHaveBeenCalled();
    expect(
      screen.getByText(content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength)),
    ).toBeInTheDocument();
  });

  it('creates the account with the token from the fragment and signs the agent in', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    transport.acceptInvite.mockResolvedValue(PRINCIPAL);
    renderSection();

    await screen.findByRole('button', { name: content.auth.inviteSubmit });

    fill(content.auth.inviteDisplayNameLabel, 'Amina Haddad');
    fill(content.auth.invitePasswordLabel, 'correct horse battery staple');
    submit();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/inbox');
    });

    expect(transport.acceptInvite).toHaveBeenCalledWith({
      token: TOKEN,
      displayName: 'Amina Haddad',
      password: 'correct horse battery staple',
    });
    expect(screen.getByText(content.auth.inviteSuccess(PREVIEW.tenantName))).toBeInTheDocument();
  });

  /**
   * The invitation is re-checked when it is accepted, so it can die between the
   * lookup and the submit — expired, withdrawn, or used by somebody else in the
   * meantime. That is the same screen state as a dead lookup, not a "try again"
   * above a form that can never succeed.
   */
  it('swaps the form for the dead-link card when the invitation dies before submit', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    transport.acceptInvite.mockRejectedValue(
      new ApiRequestError(410, 'token_invalid', 'Server-side message', null),
    );
    renderSection();

    await screen.findByRole('button', { name: content.auth.inviteSubmit });

    fill(content.auth.inviteDisplayNameLabel, 'Amina Haddad');
    fill(content.auth.invitePasswordLabel, 'correct horse battery staple');
    submit();

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteDeadLinkHeading }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.auth.inviteSubmit }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: content.auth.goToSignIn })).toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('points an already-registered address at sign-in instead of failing generically', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    transport.acceptInvite.mockRejectedValue(
      new ApiRequestError(409, 'conflict', 'Server-side message', null),
    );
    renderSection();

    await screen.findByRole('button', { name: content.auth.inviteSubmit });

    fill(content.auth.inviteDisplayNameLabel, 'Amina Haddad');
    fill(content.auth.invitePasswordLabel, 'correct horse battery staple');
    submit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      content.auth.inviteAccountExistsError,
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});
