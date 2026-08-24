import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { AdminPendingDomain } from '@whatsappcrm/contracts';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { content } from '~/content/en';
import { routes } from '~/lib/routes';
import { DomainQueueTable } from './DomainQueueTable';

const attachDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const detachDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();

vi.mock('../domains.actions', () => ({
  attachDomainAction: (input: unknown) => attachDomainAction(input),
  detachDomainAction: (input: unknown) => detachDomainAction(input),
}));

function domain(overrides: Partial<AdminPendingDomain> = {}): AdminPendingDomain {
  return {
    tenantSlug: 'northwind',
    tenantName: 'Northwind Support',
    hostname: 'support.northwind.com',
    verifiedAt: '2026-08-20T09:00:00.000Z',
    activatedAt: null,
    ...overrides,
  };
}

const renderQueue = (domains: readonly AdminPendingDomain[], status: 'verified' | 'live') =>
  render(
    <ToastProvider>
      <DomainQueueTable domains={domains} status={status} />
    </ToastProvider>,
  );

describe('DomainQueueTable', () => {
  beforeEach(() => {
    attachDomainAction.mockReset();
    detachDomainAction.mockReset();
  });

  /**
   * This queue is the only place in the console where a tenant can be *found*
   * rather than typed, which is why the row links through.
   */
  it('links the tenant, and shows the slug the rest of the console keys on', () => {
    renderQueue([domain()], 'verified');

    expect(screen.getByRole('link', { name: 'Northwind Support' })).toHaveAttribute(
      'href',
      routes.tenant('northwind'),
    );
    expect(screen.getByText('northwind')).toBeInTheDocument();
  });

  /**
   * The action comes from the half being shown, not from the row: reading
   * `activatedAt` would offer `Attach` on a row the `verified` filter had just
   * returned *because* it is not attached.
   */
  it('attaches on the waiting half', async () => {
    attachDomainAction.mockResolvedValue({ status: 'success', data: 'support.northwind.com' });
    renderQueue([domain()], 'verified');

    fireEvent.click(
      screen.getByRole('button', { name: content.domains.attachAria('support.northwind.com') }),
    );

    await waitFor(() => {
      expect(attachDomainAction).toHaveBeenCalledWith({
        slug: 'northwind',
        hostname: 'support.northwind.com',
      });
    });
    expect(detachDomainAction).not.toHaveBeenCalled();
  });

  it('detaches on the attached half', async () => {
    detachDomainAction.mockResolvedValue({ status: 'success', data: 'support.northwind.com' });
    renderQueue([domain({ activatedAt: '2026-08-21T09:00:00.000Z' })], 'live');

    fireEvent.click(
      screen.getByRole('button', { name: content.domains.detachAria('support.northwind.com') }),
    );

    await waitFor(() => {
      expect(detachDomainAction).toHaveBeenCalledWith({
        slug: 'northwind',
        hostname: 'support.northwind.com',
      });
    });
    expect(attachDomainAction).not.toHaveBeenCalled();
  });

  /** The verb *and* the subject: a column of identical "Attach" is unusable blind. */
  it('names the hostname in each row’s control', () => {
    renderQueue([domain(), domain({ hostname: 'help.northwind.com' })], 'verified');

    expect(
      screen.getByRole('button', { name: content.domains.attachAria('support.northwind.com') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.domains.attachAria('help.northwind.com') }),
    ).toBeInTheDocument();
  });

  /**
   * Above the table, not in the row: a sibling's success refetches the queue and
   * this row may move to the other half, taking an in-row message with it.
   */
  it('reports a failure above the table, naming the hostname', async () => {
    attachDomainAction.mockResolvedValue({
      status: 'error',
      message: 'No tenant is provisioned with the slug northwind.',
      requestId: 'req-2',
    });
    renderQueue([domain()], 'verified');

    fireEvent.click(
      screen.getByRole('button', { name: content.domains.attachAria('support.northwind.com') }),
    );

    /*
     * Found by its heading rather than by `role="status"`. `AlertBanner` is a
     * polite status region — the row's control is still there and the operator
     * can retry, so it must not interrupt — but so is a pending `Button`'s
     * `Spinner`, and the role alone matches whichever mounted first.
     */
    const heading = await screen.findByText(content.domains.actionFailed('support.northwind.com'));
    const banner = heading.closest('section');

    expect(banner).toHaveTextContent('No tenant is provisioned with the slug northwind.');
    // Above the table, so it survives the row moving to the other half.
    expect(banner?.compareDocumentPosition(screen.getByRole('table'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});
