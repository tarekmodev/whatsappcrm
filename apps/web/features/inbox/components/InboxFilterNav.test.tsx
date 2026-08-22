import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InboxFilterNav } from './InboxFilterNav';

vi.mock('next/navigation', () => ({
  usePathname: () => '/inbox',
}));

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';

function renderNav(overrides: Partial<Parameters<typeof InboxFilterNav>[0]> = {}) {
  render(
    <InboxFilterNav
      scope="assigned"
      status={undefined}
      conversationId={null}
      sort="newest"
      canManageChannels={false}
      {...overrides}
    />,
  );
}

/**
 * The filter column. Every entry is a real link carrying the current thread, and
 * the only entries offered are ones the conversations endpoint can answer.
 */
describe('InboxFilterNav', () => {
  it('marks the entry the current filter is on', () => {
    renderNav({ scope: 'unassigned' });

    expect(screen.getByRole('link', { name: 'Unassigned' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('link', { name: 'Assigned to me' })).not.toHaveAttribute(
      'aria-current',
    );
  });

  it('keeps the open conversation when the filter changes', () => {
    // Switching filter must not close what an agent is reading: the thread is
    // fetched by id and does not depend on the list's scope.
    renderNav({ conversationId: CONVERSATION_ID });

    expect(screen.getByRole('link', { name: 'Unassigned' })).toHaveAttribute(
      'href',
      `/inbox?scope=unassigned&conversation=${CONVERSATION_ID}`,
    );
  });

  it('hides the secondary filters behind More', () => {
    renderNav();

    expect(screen.queryByRole('link', { name: 'Resolved' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'More' }));

    expect(screen.getByRole('link', { name: 'Resolved' })).toHaveAttribute(
      'href',
      '/inbox?scope=all&status=resolved',
    );
  });

  it('offers the settings link only to somebody who can reach it', () => {
    renderNav();
    expect(screen.queryByRole('link', { name: /inbox settings/i })).not.toBeInTheDocument();

    renderNav({ canManageChannels: true });
    expect(screen.getByRole('link', { name: /inbox settings/i })).toHaveAttribute(
      'href',
      '/settings/whatsapp',
    );
  });
});
