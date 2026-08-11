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
import { fieldByLabel } from '@/lib/testing/field-queries';
import { InviteAcceptSection } from './InviteAcceptSection';

/**
 * Every outcome the invitation link can have, from the fragment upwards. The
 * token only ever exists in `location.hash`, so these open the page the way the
 * emailed link does.
 */

const router = vi.hoisted(() => ({ replace: vi.fn(), refresh: vi.fn() }));
const transport = vi.hoisted(() => ({ lookupInvite: vi.fn(), acceptInvite: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));

vi.mock('@/lib/api/auth-browser', () => ({
  login: vi.fn(),
  lookupInvite: transport.lookupInvite,
  acceptInvite: transport.acceptInvite,
}));

const TOKEN = 'a-256-bit-token';
const NEW_PASSWORD = 'a-perfectly-fine-passphrase';

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

function openLinkWith(fragment: string): void {
  window.history.replaceState(null, '', `/invite${fragment}`);
}

function renderSection() {
  return render(
    <ToastProvider>
      <InviteAcceptSection />
    </ToastProvider>,
  );
}

function fillAndSubmit(password = NEW_PASSWORD, confirmation = password): void {
  fireEvent.change(fieldByLabel(content.auth.inviteDisplayNameLabel), {
    target: { value: 'Amina Haddad' },
  });
  fireEvent.change(fieldByLabel(content.auth.invitePasswordLabel), {
    target: { value: password },
  });
  fireEvent.change(fieldByLabel(content.auth.confirmPasswordLabel), {
    target: { value: confirmation },
  });
  fireEvent.click(screen.getByRole('button', { name: content.auth.inviteSubmit }));
}

async function waitForForm(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByRole('button', { name: content.auth.inviteSubmit })).toBeInTheDocument();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  openLinkWith(`#token=${TOKEN}`);
});

describe('InviteAcceptSection', () => {
  it('announces the wait once and reserves the shape of what is coming', () => {
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
    openLinkWith('');

    // A fresh module registry stands in for a fresh document: `useLinkToken`
    // remembers the token for the life of the document it arrived in, so this has
    // to be a new one rather than a remount of the link another test opened.
    vi.resetModules();
    const { InviteAcceptSection: FreshDocument } = await import('./InviteAcceptSection');

    render(
      <ToastProvider>
        <FreshDocument />
      </ToastProvider>,
    );

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteUnusableHeading }),
    ).toBeInTheDocument();
    expect(screen.getByText(content.auth.inviteIncompleteBody)).toBeInTheDocument();
    expect(transport.lookupInvite).not.toHaveBeenCalled();
    // Nothing to retry, so the only action offered is the one that still works.
    expect(screen.getByRole('link', { name: content.auth.backToSignIn })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('scrubs the token from the address bar once it has been read', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    renderSection();

    await waitForForm();

    // A live credential must not survive in the URL for a screenshot or the next
    // person to glance at the screen.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/invite');
  });

  it('offers a way forward when the invitation is expired, used or withdrawn', async () => {
    transport.lookupInvite.mockRejectedValue(
      new ApiRequestError(410, 'token_invalid', 'Server-side message', null),
    );
    renderSection();

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteUnusableHeading }),
    ).toBeInTheDocument();
    expect(screen.getByText(content.auth.inviteDeadLinkBody)).toBeInTheDocument();
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
    await waitForForm();

    fillAndSubmit('short');

    expect(transport.acceptInvite).not.toHaveBeenCalled();
    expect(
      screen.getByText(content.auth.passwordTooShortError(AUTH_POLICY.passwordMinLength)),
    ).toBeInTheDocument();
  });

  it('catches a mistyped confirmation, which the contract has no field for', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    renderSection();
    await waitForForm();

    fillAndSubmit(NEW_PASSWORD, `${NEW_PASSWORD}-typo`);

    expect(transport.acceptInvite).not.toHaveBeenCalled();
    expect(screen.getByText(content.auth.passwordMismatchError)).toBeInTheDocument();
  });

  it('creates the account with the token from the fragment and signs the agent in', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    transport.acceptInvite.mockResolvedValue(PRINCIPAL);
    renderSection();
    await waitForForm();

    fillAndSubmit();

    await waitFor(() => {
      expect(router.replace).toHaveBeenCalledWith('/inbox');
    });

    expect(transport.acceptInvite).toHaveBeenCalledWith({
      token: TOKEN,
      displayName: 'Amina Haddad',
      password: NEW_PASSWORD,
    });
    expect(screen.getByText(content.auth.inviteSuccess(PREVIEW.tenantName))).toBeInTheDocument();
  });

  /**
   * The API re-checks the invitation when it accepts, so it can die between the
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
    await waitForForm();

    fillAndSubmit();

    expect(
      await screen.findByRole('heading', { name: content.auth.inviteUnusableHeading }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: content.auth.inviteSubmit }),
    ).not.toBeInTheDocument();
    expect(router.replace).not.toHaveBeenCalled();
  });

  it('points an already-registered address at sign-in instead of failing generically', async () => {
    transport.lookupInvite.mockResolvedValue(PREVIEW);
    transport.acceptInvite.mockRejectedValue(
      new ApiRequestError(409, 'conflict', 'Server-side message', null),
    );
    renderSection();
    await waitForForm();

    fillAndSubmit();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      content.auth.inviteAccountExistsError,
    );
    expect(router.replace).not.toHaveBeenCalled();
  });
});
