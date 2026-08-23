import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { SignupCompletedResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ApiRequestError } from '@/lib/api/error';
import { SignupVerifySection } from './SignupVerifySection';

/**
 * Every outcome the verification link can have, from the fragment upwards. The
 * token only ever exists in `location.hash`, so these open the page the way the
 * emailed link does — the same shape as `InviteAcceptSection.test.tsx`, and for
 * the same reason.
 */

const transport = vi.hoisted(() => ({ verifySignup: vi.fn() }));

vi.mock('@/lib/api/auth-browser', () => ({
  login: vi.fn(),
  lookupInvite: vi.fn(),
  acceptInvite: vi.fn(),
  requestSignup: vi.fn(),
  verifySignup: transport.verifySignup,
  resendSignupVerification: vi.fn(),
  checkSlugAvailability: vi.fn(),
}));

const TOKEN = 'a-256-bit-token';
const HOSTNAME = 'northwind.app.example.com';

const COMPLETED = {
  tenant: {
    id: '0192f000-0000-7000-8000-000000000001',
    slug: 'northwind',
    name: 'Northwind Support',
    status: 'active',
    primaryHostname: HOSTNAME,
    settings: { timezone: 'Europe/London', locale: 'en' },
    createdAt: '2026-08-23T10:00:00.000Z',
  },
  user: {
    userId: '0192f001-0000-7000-8000-000000000101',
    tenantId: '0192f000-0000-7000-8000-000000000001',
    email: 'amina@northwind.example',
    displayName: 'Amina Haddad',
    role: 'admin',
    permissions: [],
    teamIds: [],
    sessionId: '0192f003-0000-7000-8000-000000000301',
    expiresAt: '2026-08-30T10:00:00.000Z',
  },
  primaryHostname: HOSTNAME,
} satisfies SignupCompletedResponse;

function openLinkWith(fragment: string): void {
  window.history.replaceState(null, '', `/verify${fragment}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  openLinkWith(`#token=${TOKEN}`);
});

describe('SignupVerifySection', () => {
  it('announces the wait once and holds the shape of whichever card is coming', () => {
    // Never settles: provisioning a workspace is the slow part, and the state
    // while it runs is what is under test.
    transport.verifySignup.mockReturnValue(new Promise(() => undefined));
    render(<SignupVerifySection />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.auth.verifyPending);
  });

  it('spends the token exactly once, however many times the screen renders', async () => {
    transport.verifySignup.mockResolvedValue(COMPLETED);
    const { rerender } = render(<SignupVerifySection />);

    await screen.findByRole('link', { name: content.auth.verifyOpenWorkspace });

    rerender(<SignupVerifySection />);

    // The token is single-use: a second call spends nothing and answers
    // `token_invalid`, which would turn a successful signup into a dead link.
    expect(transport.verifySignup).toHaveBeenCalledTimes(1);
    expect(transport.verifySignup).toHaveBeenCalledWith({ token: TOKEN });
  });

  it('hands the new administrator to their own workspace, and says why they sign in again', async () => {
    transport.verifySignup.mockResolvedValue(COMPLETED);
    render(<SignupVerifySection />);

    expect(
      await screen.findByRole('heading', {
        name: content.auth.verifyDoneHeading(COMPLETED.tenant.name),
      }),
    ).toBeInTheDocument();

    /*
     * The session cookie is `__Host-` scoped to the platform host this page is
     * on, so it cannot travel to the tenant's own subdomain. The way forward is
     * that host's sign-in page, carrying `?next=` to the checklist — which is
     * what makes verification end in onboarding rather than at a dead end.
     */
    expect(screen.getByRole('link', { name: content.auth.verifyOpenWorkspace })).toHaveAttribute(
      'href',
      `http://${HOSTNAME}/login?next=%2Fonboarding`,
    );
    expect(screen.getByText(content.auth.verifySignInNotice)).toBeInTheDocument();
  });

  it('scrubs the token from the address bar once it has been read', async () => {
    transport.verifySignup.mockResolvedValue(COMPLETED);
    render(<SignupVerifySection />);

    await screen.findByRole('link', { name: content.auth.verifyOpenWorkspace });

    // A live credential must not survive in the URL for a screenshot or the next
    // person to glance at the screen.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/verify');
  });

  it('offers a fresh start for a link that has expired or already been used', async () => {
    transport.verifySignup.mockRejectedValue(
      new ApiRequestError(410, 'token_invalid', 'Server-side message', null),
    );
    render(<SignupVerifySection />);

    expect(
      await screen.findByRole('heading', { name: content.auth.verifyUnusableHeading }),
    ).toBeInTheDocument();
    expect(screen.getByText(content.auth.verifyDeadLinkBody)).toBeInTheDocument();
    // Signing in is not the way out of this one: there is no account yet.
    expect(screen.getByRole('link', { name: content.auth.signupStartAgain })).toHaveAttribute(
      'href',
      '/signup',
    );
  });

  it('lets a transport failure be retried on the same link', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    transport.verifySignup.mockRejectedValueOnce(
      new ApiRequestError(503, 'upstream_error', 'Server-side message', 'request-1'),
    );
    transport.verifySignup.mockResolvedValueOnce(COMPLETED);
    render(<SignupVerifySection />);

    expect(await screen.findByRole('alert')).toHaveTextContent(content.auth.verifyFailedError);

    fireEvent.click(screen.getByRole('button', { name: content.auth.verifyRetry }));

    await waitFor(() => {
      expect(
        screen.getByRole('link', { name: content.auth.verifyOpenWorkspace }),
      ).toBeInTheDocument();
    });
  });

  it('explains a link that arrived without its fragment', async () => {
    openLinkWith('');

    // A fresh module registry stands in for a fresh document: `useLinkToken`
    // remembers the token for the life of the document it arrived in, so this has
    // to be a new one rather than a remount of the link another test opened.
    vi.resetModules();
    const { SignupVerifySection: FreshDocument } = await import('./SignupVerifySection');

    render(<FreshDocument />);

    expect(
      await screen.findByRole('heading', { name: content.auth.verifyUnusableHeading }),
    ).toBeInTheDocument();
    expect(screen.getByText(content.auth.verifyIncompleteBody)).toBeInTheDocument();
    expect(transport.verifySignup).not.toHaveBeenCalled();
  });
});
