import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TenantDomain } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { DomainCard } from './DomainCard';

const verifyDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<TenantDomain>>>();
const setPrimaryDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<TenantDomain>>>();
const removeDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<void>>>();

vi.mock('../domains.actions', () => ({
  verifyDomainAction: (input: unknown) => verifyDomainAction(input),
  setPrimaryDomainAction: (input: unknown) => setPrimaryDomainAction(input),
  removeDomainAction: (input: unknown) => removeDomainAction(input),
}));

function domain(overrides: Partial<TenantDomain> = {}): TenantDomain {
  return {
    id: '0192f00a-0000-7000-8000-00000000e002',
    hostname: 'support.acme.com',
    kind: 'custom',
    status: 'pending_verification',
    isPrimary: false,
    verifiedAt: null,
    activatedAt: null,
    verification: {
      recordType: 'TXT',
      recordName: '_whatsappcrm-challenge.support.acme.com',
      recordValue: 'whatsappcrm-domain-verification=7f3c1a9be25d4867b0a1c4e8d9f2b6a3',
      lastCheckedAt: null,
      lastFailureReason: null,
      expiresAt: '2026-08-21T09:00:00.000Z',
    },
    routing: {
      recordType: 'CNAME',
      recordName: 'support.acme.com',
      recordValue: 'whatsappcrm-web.onrender.example',
    },
    createdAt: '2026-08-14T09:00:00.000Z',
    ...overrides,
  };
}

function renderCard(item: TenantDomain) {
  return render(
    <ToastProvider>
      <DomainCard domain={item} />
    </ToastProvider>,
  );
}

describe('DomainCard', () => {
  beforeEach(() => {
    verifyDomainAction.mockReset();
    setPrimaryDomainAction.mockReset();
    removeDomainAction.mockReset();
  });

  it('shows the exact TXT record a pending domain needs', () => {
    renderCard(domain());

    // The audience is alt-tabbing to a registrar; a paraphrased record is a
    // domain that never verifies for a reason nobody can see.
    expect(screen.getByText('_whatsappcrm-challenge.support.acme.com')).toBeInTheDocument();
    expect(
      screen.getByText('whatsappcrm-domain-verification=7f3c1a9be25d4867b0a1c4e8d9f2b6a3'),
    ).toBeInTheDocument();
  });

  it('names which of the four things went wrong on the last check', () => {
    renderCard(
      domain({
        verification: {
          recordType: 'TXT',
          recordName: '_whatsappcrm-challenge.support.acme.com',
          recordValue: 'whatsappcrm-domain-verification=7f3c1a9be25d4867b0a1c4e8d9f2b6a3',
          lastCheckedAt: '2026-08-14T09:30:00.000Z',
          lastFailureReason: 'record_mismatch',
          expiresAt: '2026-08-21T09:00:00.000Z',
        },
      }),
    );

    // "A record exists but the value does not match" and "no record yet" send
    // somebody to two completely different places.
    expect(screen.getByText(content.domains.failureReasons.record_mismatch)).toBeInTheDocument();
  });

  it('says the check found nothing rather than claiming success', async () => {
    const stillPending = domain();

    verifyDomainAction.mockResolvedValue({ status: 'success', data: stillPending });

    renderCard(stillPending);

    fireEvent.click(screen.getByRole('button', { name: content.domains.verifyButton }));

    expect(
      await screen.findByText(content.domains.stillPendingToast(stillPending.hostname)),
    ).toBeInTheDocument();
  });

  it('confirms a verified check', async () => {
    const verified = domain({ status: 'verified', verifiedAt: '2026-08-14T10:00:00.000Z' });

    verifyDomainAction.mockResolvedValue({ status: 'success', data: verified });

    renderCard(domain());

    fireEvent.click(screen.getByRole('button', { name: content.domains.verifyButton }));

    expect(
      await screen.findByText(content.domains.verifiedToast(verified.hostname)),
    ).toBeInTheDocument();
  });

  it('does not offer to make an unproved hostname primary', () => {
    renderCard(domain());

    // Invite and password-reset links are mailed to the primary host.
    expect(
      screen.queryByRole('button', { name: content.domains.setPrimaryButton }),
    ).not.toBeInTheDocument();
  });

  it('offers primary once ownership is proved', () => {
    renderCard(domain({ status: 'verified', verifiedAt: '2026-08-14T10:00:00.000Z' }));

    expect(
      screen.getByRole('button', { name: content.domains.setPrimaryButton }),
    ).toBeInTheDocument();
  });

  it('never offers to remove the platform subdomain, and says why', () => {
    renderCard(
      domain({
        kind: 'platform',
        hostname: 'acme.whatsappcrm.example',
        status: 'live',
        verifiedAt: '2026-06-01T08:00:00.000Z',
        isPrimary: true,
        verification: null,
        routing: null,
      }),
    );

    expect(
      screen.queryByRole('button', { name: content.domains.removeButton }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(content.domains.platformNotRemovable)).toBeInTheDocument();
  });

  it('confirms a removal, naming what happens, before calling the action', async () => {
    removeDomainAction.mockResolvedValue({ status: 'success', data: undefined });

    renderCard(domain());

    fireEvent.click(screen.getByRole('button', { name: content.domains.removeButton }));

    // Destructive and immediate: the dialog says what stops working, not "are
    // you sure?".
    expect(await screen.findByText(content.domains.removeConfirmBody)).toBeInTheDocument();
    expect(removeDomainAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: content.domains.removeConfirm }));

    await waitFor(() => {
      expect(removeDomainAction).toHaveBeenCalledWith(domain().id);
    });
  });

  it('warns that invite links move when the primary domain is removed', async () => {
    renderCard(domain({ isPrimary: true, verifiedAt: '2026-08-14T10:00:00.000Z' }));

    fireEvent.click(screen.getByRole('button', { name: content.domains.removeButton }));

    expect(await screen.findByText(content.domains.removePrimaryWarning)).toBeInTheDocument();
  });
});
