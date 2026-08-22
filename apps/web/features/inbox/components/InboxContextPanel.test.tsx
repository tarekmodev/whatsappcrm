import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
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
    botState: 'off',
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

  it('names what each contact field is, rather than leaving loose lines', () => {
    // A phone number, an email address and a row of tags with nothing saying
    // which is which is a `<dl>` written without its terms (TAR-518).
    render(
      <InboxContextPanel
        conversation={conversation({
          contact: {
            ...conversation().contact,
            email: 'fatima@northwind.example',
            tags: [{ id: 'tag-vip', name: 'VIP', color: '#0f6fde' }],
          },
        })}
      />,
    );

    expect(screen.getByText(content.inbox.contactPhoneLabel)).toBeInTheDocument();
    expect(screen.getByText(content.inbox.contactEmailLabel)).toBeInTheDocument();
    expect(screen.getByText(content.inbox.contactTagsLabel)).toBeInTheDocument();
    expect(screen.getByText('VIP')).toBeInTheDocument();
  });

  it('renders the ticket the section handed it, rather than deciding for itself', () => {
    // What the linked ticket says is a second endpoint's answer, and it arrives
    // as a slot with its own Suspense and error boundary — a contact card must
    // not be held up, or taken down, by a read about something attached to it.
    render(
      <InboxContextPanel
        conversation={conversation({ ticketId: '0192f004-0000-7000-8000-000000000501' })}
        ticket={<p>Ticket #42</p>}
      />,
    );

    expect(screen.getByText('Ticket #42')).toBeInTheDocument();
    // Tickets are opened by the auto-linking pipeline, never by a button here —
    // 0002 exposes no create endpoint, and a control that called nothing would
    // be worse than saying what happened.
    expect(screen.queryByRole('button', { name: /ticket/i })).not.toBeInTheDocument();
  });

  it('says how a ticket will arrive when there is none yet', () => {
    render(<InboxContextPanel conversation={conversation({ ticketId: null })} />);

    expect(screen.getByText(content.inbox.ticketUnlinked)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /ticket/i })).not.toBeInTheDocument();
  });
});
