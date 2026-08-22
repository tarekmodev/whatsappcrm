import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ConversationResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { threadState } from '@/features/inbox/thread-state';
import { conversationHold, isConversationUnclaimed } from '@/features/inbox/conversation-hold';
import { InboxLayout } from './InboxLayout';
import { ThreadHeader, type ThreadQuery } from './ThreadHeader';

/**
 * TAR-518's fourth acceptance criterion: the thread header renders **exactly one
 * solid accent button** and no more than two status chips.
 *
 * Both halves were broken on `main`. A conversation the chatbot was answering
 * and nobody had claimed drew `Take over from the bot` and `Claim` side by side,
 * both accent — and the emphasis is asserted here through `threadState` rather
 * than by passing it in, so what is tested is the decision the thread actually
 * makes.
 */

vi.mock('@/features/inbox/inbox.actions', () => ({
  claimConversationAction: vi.fn(),
  takeOverConversationAction: vi.fn(),
  releaseConversationAction: vi.fn(),
  takeOverFromBotAction: vi.fn(),
  setConversationStatusAction: vi.fn(),
}));

const CURRENT_USER = '0192f001-0000-7000-8000-000000000101';
const QUERY: ThreadQuery = { scope: 'all', status: undefined, sort: 'newest' };
const EVERY_PERMISSION = { canClaim: true, canAssign: true };

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

function renderHeader(overrides: Partial<ConversationResponse> = {}, assigneeName?: string) {
  const open = conversation(overrides);
  const isUnclaimed = isConversationUnclaimed(open.assignedUserId, open.assignedTeamId);
  const { emphasis } = threadState({
    hold: conversationHold(open.assignedUserId, CURRENT_USER, assigneeName ?? null),
    isUnclaimed,
    botState: open.botState,
    permissions: EVERY_PERMISSION,
    canSend: true,
  });

  return render(
    <ToastProvider>
      <InboxLayout
        hasThread
        filters={null}
        list={null}
        context={null}
        thread={
          <ThreadHeader
            conversation={open}
            assigneeName={assigneeName ?? null}
            teamName={null}
            holdPermissions={EVERY_PERMISSION}
            currentUserId={CURRENT_USER}
            query={QUERY}
            emphasis={emphasis}
            isUnclaimed={isUnclaimed}
          />
        }
      />
    </ToastProvider>,
  );
}

/** A solid accent button is `Button`'s `primary` variant, and nothing else is. */
function accentButtons(): HTMLElement[] {
  return screen.getAllByRole('button').filter((button) => button.dataset.variant === 'primary');
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ThreadHeader', () => {
  it('draws one solid accent button on a thread the chatbot is answering and nobody holds', () => {
    renderHeader({ botState: 'bot_active' });

    expect(accentButtons()).toHaveLength(1);
    // Claiming is the gate: stopping the chatbot does not assign the thread, so
    // the agent still could not reply afterwards.
    expect(accentButtons()[0]).toHaveAccessibleName(content.inbox.claimAria('Fatima Al-Zahra'));
    // …and the other control is still offered, just quietly.
    expect(
      screen.getByRole('button', { name: content.inbox.takeFromBotAria('Fatima Al-Zahra') }),
    ).toBeInTheDocument();
  });

  it('promotes the handoff once the thread is held', () => {
    renderHeader({ botState: 'bot_active', assignedUserId: CURRENT_USER }, 'Omar Farouk');

    expect(accentButtons()).toHaveLength(1);
    expect(accentButtons()[0]).toHaveAccessibleName(
      content.inbox.takeFromBotAria('Fatima Al-Zahra'),
    );
  });

  it('draws no accent button at all on a held thread with nothing urgent to do', () => {
    renderHeader({ assignedUserId: CURRENT_USER }, 'Omar Farouk');

    expect(accentButtons()).toHaveLength(0);
    expect(
      screen.getByRole('button', { name: content.inbox.closeConversation }),
    ).toBeInTheDocument();
  });

  it('names who holds the thread in text, not only as an initial in a circle', () => {
    // One conversation is open and being read, and "who is on this" should not
    // need a hover to answer.
    renderHeader({ assignedUserId: '0192f001-0000-7000-8000-000000000102' }, 'Amina Haddad');

    expect(screen.getByText(content.inbox.assignedTo('Amina Haddad'))).toBeInTheDocument();
  });

  it('carries no notice of its own — the composer says why in one line', () => {
    const { container } = renderHeader({ botState: 'bot_active' });

    for (const line of Object.values(content.composer.guidance)) {
      expect(container.textContent).not.toContain(line);
    }
  });
});
