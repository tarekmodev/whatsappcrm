import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { InboxContextPanel } from './InboxContextPanel';

function conversation(overrides: Partial<ConversationResponse> = {}): ConversationResponse {
  return {
    id: '0192f004-0000-7000-8000-000000000401',
    contact: {
      id: '0192f004-0000-7000-8000-000000000301',
      phone: '+966501234567',
      waProfileName: 'Fatima Al-Zahra',
      displayName: 'Fatima Al-Zahra',
      email: null,
      tags: [],
      customFields: {},
      lastContactedAt: null,
      optedOutAt: null,
      createdAt: '2026-08-09T14:00:00.000Z',
      updatedAt: '2026-08-10T08:45:00.000Z',
    },
    whatsappAccountId: '0192f004-0000-7000-8000-000000000201',
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

describe('InboxContextPanel', () => {
  it('names the contact the conversation is with', () => {
    render(<InboxContextPanel conversation={conversation()} />);

    expect(screen.getByRole('heading', { name: 'Contact' })).toBeInTheDocument();
    expect(screen.getByText('Fatima Al-Zahra')).toBeInTheDocument();
    expect(screen.getByText('+966501234567')).toBeInTheDocument();
  });

  it('reports a linked ticket rather than offering to create one', () => {
    // Tickets are opened by the auto-linking pipeline, never by a button here —
    // 0002 exposes no create endpoint, and a control that called nothing would
    // be worse than saying what happened.
    render(
      <InboxContextPanel
        conversation={conversation({ ticketId: '0192f004-0000-7000-8000-000000000501' })}
      />,
    );

    expect(screen.getByText(/a ticket is open for this conversation/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ticket/i })).not.toBeInTheDocument();
  });

  it('says how a ticket will arrive when there is none yet', () => {
    render(<InboxContextPanel conversation={conversation({ ticketId: null })} />);

    expect(screen.getByText('No ticket yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ticket/i })).not.toBeInTheDocument();
  });
});
