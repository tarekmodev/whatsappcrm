import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AdminPendingDomain } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import { ToastProvider } from '@/components/ui/ToastProvider';
import type { ActionResult } from '@/lib/actions/result';
import { DomainQueueTable } from './DomainQueueTable';

const activateTenantDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();
const deactivateTenantDomainAction = vi.fn<(input: unknown) => Promise<ActionResult<string>>>();

vi.mock('../platform-admin.actions', () => ({
  activateTenantDomainAction: (input: unknown) => activateTenantDomainAction(input),
  deactivateTenantDomainAction: (input: unknown) => deactivateTenantDomainAction(input),
}));

const copy = content.platformAdmin.domains;

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

function renderQueue(domains: readonly AdminPendingDomain[], status: 'verified' | 'live') {
  return render(
    <ToastProvider>
      <DomainQueueTable domains={domains} status={status} />
    </ToastProvider>,
  );
}

describe('DomainQueueTable', () => {
  beforeEach(() => {
    activateTenantDomainAction.mockReset();
    deactivateTenantDomainAction.mockReset();
  });

  it('names the tenant and links to its screen — the only place one can be found', () => {
    renderQueue([domain()], 'verified');

    const link = screen.getByRole('link', { name: 'Northwind Support' });

    expect(link).toHaveAttribute('href', routes.adminTenant('northwind'));
  });

  it('says a waiting domain is not attached yet rather than leaving the cell blank', () => {
    renderQueue([domain()], 'verified');

    expect(screen.getByText(copy.notAttached)).toBeInTheDocument();
  });

  /**
   * The action comes from the half of the queue being shown, not from the row.
   * Reading `activatedAt` instead would offer "Mark attached" on a row the
   * `verified` filter had just returned *because* it is not attached.
   */
  it('offers activation on the waiting half', async () => {
    activateTenantDomainAction.mockResolvedValue({
      status: 'success',
      data: 'support.northwind.com',
    });
    renderQueue([domain()], 'verified');

    fireEvent.click(screen.getByRole('button', { name: copy.activateAria('support.northwind.com') }));

    await waitFor(() => {
      expect(activateTenantDomainAction).toHaveBeenCalledWith({
        slug: 'northwind',
        hostname: 'support.northwind.com',
      });
    });
    expect(deactivateTenantDomainAction).not.toHaveBeenCalled();
  });

  it('offers the inverse on the attached half', async () => {
    deactivateTenantDomainAction.mockResolvedValue({
      status: 'success',
      data: 'support.northwind.com',
    });
    renderQueue([domain({ activatedAt: '2026-08-21T09:00:00.000Z' })], 'live');

    fireEvent.click(
      screen.getByRole('button', { name: copy.deactivateAria('support.northwind.com') }),
    );

    await waitFor(() => {
      expect(deactivateTenantDomainAction).toHaveBeenCalledWith({
        slug: 'northwind',
        hostname: 'support.northwind.com',
      });
    });
    expect(activateTenantDomainAction).not.toHaveBeenCalled();
  });

  /**
   * The verb *and* the subject. A column of identical "Mark attached" is a table
   * nobody can use without sight of it.
   */
  it('names the hostname in each row’s control, so two rows are distinguishable', () => {
    renderQueue([domain(), domain({ hostname: 'help.northwind.com' })], 'verified');

    expect(
      screen.getByRole('button', { name: copy.activateAria('support.northwind.com') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: copy.activateAria('help.northwind.com') }),
    ).toBeInTheDocument();
  });

  /**
   * In the row rather than in a toast: a dismissed toast is a failure nobody can
   * go back and read, and the row is where the operator is looking.
   */
  it('reports a refusal in the row it belongs to', async () => {
    activateTenantDomainAction.mockResolvedValue({
      status: 'error',
      message: 'No tenant is provisioned with the slug northwind.',
      requestId: 'req-2',
    });
    renderQueue([domain(), domain({ hostname: 'help.northwind.com' })], 'verified');

    fireEvent.click(screen.getByRole('button', { name: copy.activateAria('help.northwind.com') }));

    const alert = await screen.findByRole('alert');

    expect(alert).toHaveTextContent('No tenant is provisioned with the slug northwind.');
    // One row failed, so exactly one row says so.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(
      within(screen.getByRole('table')).getAllByRole('row').length,
    ).toBeGreaterThan(1);
  });
});
