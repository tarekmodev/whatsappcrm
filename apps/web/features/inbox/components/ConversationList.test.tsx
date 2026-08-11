import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ConversationList, ConversationListSkeleton } from './ConversationList';

/**
 * TAR-20's first acceptance criterion in the list: a conversation nobody has
 * claimed is visible and says so, and opening one is a real link carrying the
 * filters — so a copied URL and the back button reproduce the same view.
 */

const CONTACT: ConversationResponse['contact'] = {
  id: '0192f003-0000-7000-8000-000000000301',
  phone: '+966501234567',
  waProfileName: 'Fatima Al-Zahra',
  displayName: 'Fatima Al-Zahra',
  email: null,
  tags: [],
  customFields: {},
  lastContactedAt: null,
  optedOutAt: null,
  createdAt: '2026-07-01T08:00:00.000Z',
  updatedAt: '2026-08-09T09:15:00.000Z',
};

const ASSIGNED_ID = '0192f004-0000-7000-8000-000000000401';
const UNCLAIMED_ID = '0192f004-0000-7000-8000-000000000404';
const AMINA_ID = '0192f001-0000-7000-8000-000000000101';
const BILLING_ID = '0192f002-0000-7000-8000-000000000201';

function conversation(overrides: Partial<ConversationResponse>): ConversationResponse {
  return {
    id: ASSIGNED_ID,
    contact: CONTACT,
    whatsappAccountId: '0192f005-0000-7000-8000-000000000501',
    status: 'open',
    assignedUserId: null,
    assignedTeamId: null,
    ticketId: null,
    unreadCount: 0,
    serviceWindowExpiresAt: null,
    botHandling: false,
    lastMessagePreview: null,
    lastMessageAt: '2026-08-10T08:45:00.000Z',
    createdAt: '2026-08-09T14:00:00.000Z',
    updatedAt: '2026-08-10T08:45:00.000Z',
    ...overrides,
  };
}

const NAMES = new Map([[AMINA_ID, 'Amina Haddad']]);
const TEAMS = new Map([[BILLING_ID, 'Billing']]);
const QUERY = { scope: 'all', status: 'open' } as const;

describe('ConversationList', () => {
  it('opens each conversation through a link that carries the current filters', () => {
    render(
      <ConversationList
        conversations={[conversation({})]}
        userNames={NAMES}
        teamNames={TEAMS}
        query={QUERY}
        selectedId={null}
      />,
    );

    const link = screen.getByRole('link', {
      name: content.inbox.openConversation('Fatima Al-Zahra'),
    });

    expect(link).toHaveAttribute(
      'href',
      `/inbox?scope=all&status=open&conversation=${ASSIGNED_ID}`,
    );
  });

  it('marks the open conversation for assistive technology, not only in colour', () => {
    render(
      <ConversationList
        conversations={[conversation({}), conversation({ id: UNCLAIMED_ID })]}
        userNames={NAMES}
        teamNames={TEAMS}
        query={QUERY}
        selectedId={ASSIGNED_ID}
      />,
    );

    const links = screen.getAllByRole('link');

    expect(links[0]).toHaveAttribute('aria-current', 'true');
    expect(links[1]).not.toHaveAttribute('aria-current');
  });

  it('says which conversations nobody has claimed', () => {
    render(
      <ConversationList
        conversations={[conversation({})]}
        userNames={NAMES}
        teamNames={TEAMS}
        query={QUERY}
        selectedId={null}
      />,
    );

    expect(screen.getByText(content.inbox.unclaimed)).toBeInTheDocument();
  });

  it('resolves the assignee and the routed team rather than rendering raw ids', () => {
    render(
      <ConversationList
        conversations={[
          conversation({ assignedUserId: AMINA_ID, assignedTeamId: BILLING_ID, unreadCount: 2 }),
        ]}
        userNames={NAMES}
        teamNames={TEAMS}
        query={QUERY}
        selectedId={null}
      />,
    );

    expect(screen.getByText(content.inbox.assignedTo('Amina Haddad'))).toBeInTheDocument();
    expect(screen.getByText(content.inbox.assignedToTeam('Billing'))).toBeInTheDocument();
    expect(screen.getByText(content.inbox.unreadCount(2))).toBeInTheDocument();
    expect(screen.queryByText(AMINA_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(content.inbox.unclaimed)).not.toBeInTheDocument();
  });

  it('explains an empty list rather than rendering a blank panel', () => {
    render(
      <ConversationList
        conversations={[]}
        userNames={NAMES}
        teamNames={TEAMS}
        query={{ scope: 'assigned', status: undefined }}
        selectedId={null}
      />,
    );

    expect(screen.getByText(content.inbox.emptyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.inbox.emptyBody)).toBeInTheDocument();
  });
});

describe('ConversationListSkeleton', () => {
  it('announces the load exactly once, politely', () => {
    render(<ConversationListSkeleton />);

    const announcements = screen.getAllByRole('status');

    expect(announcements).toHaveLength(1);
    expect(announcements[0]).toHaveTextContent(content.inbox.loadingConversations);
  });

  it('hides its placeholder rows from assistive technology', () => {
    const { container } = render(<ConversationListSkeleton />);

    expect(container.querySelector('ul')).toHaveAttribute('aria-hidden', 'true');
  });
});
