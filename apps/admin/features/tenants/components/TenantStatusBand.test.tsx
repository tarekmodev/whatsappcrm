import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TENANT_STATUSES, type TenantStatus } from '@whatsappcrm/contracts';
import { content } from '~/content/en';
import { TenantStatusBand } from './TenantStatusBand';

/**
 * The band exists because the status was a `<dt>`/`<dd>` row two cards down, and
 * this screen's job is to answer "what state is this tenant in" before somebody
 * opens the Manage menu.
 */
describe('TenantStatusBand', () => {
  it.each(TENANT_STATUSES)('names %s in words, not in colour alone', (status: TenantStatus) => {
    render(<TenantStatusBand status={status} />);

    expect(screen.getByText(content.tenantStatuses[status])).toBeInTheDocument();
  });

  /**
   * An operator about to press Suspend needs the difference between "active" and
   * "we could not tell" to be visible — so an unreadable status says so rather
   * than rendering nothing.
   */
  it('says so when the trail could not supply a status', () => {
    render(<TenantStatusBand status={null} />);

    expect(screen.getByText(content.tenant.statusUnknown)).toBeInTheDocument();
  });

  it('is a named region, so the chip is not a bare word to a screen reader', () => {
    render(<TenantStatusBand status="active" />);

    expect(screen.getByRole('region', { name: content.tenant.bandLabel })).toBeInTheDocument();
  });
});
