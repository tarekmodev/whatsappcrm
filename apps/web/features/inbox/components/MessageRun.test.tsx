import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MessageResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { ToastProvider } from '@/components/ui/ToastProvider';
import { groupMessagesIntoRuns } from '@/features/inbox/message-runs';
import { MessageRun } from './MessageRun';

/**
 * TAR-518's second acceptance criterion — a run of three consecutive messages
 * from one sender is served by one avatar and one sender label — and the
 * attribution rules that moved here off the bubble.
 *
 * Attribution is tested through `groupMessagesIntoRuns` rather than by hand-built
 * runs, so what these assert is what the list actually renders.
 */

const CONTACT = 'Fatima Al-Zahra';
const AGENT_ID = '0192f001-0000-7000-8000-000000000101';
const NAMES = new Map([[AGENT_ID, 'Amina Haddad']]);

const BASE: MessageResponse = {
  id: '0192f006-0000-7000-8000-000000000601',
  conversationId: '0192f004-0000-7000-8000-000000000401',
  direction: 'inbound',
  type: 'text',
  status: 'delivered',
  body: 'Hello',
  attachments: [],
  sentByUserId: null,
  sentByAutomation: false,
  origin: 'contact',
  providerMessageId: null,
  failureReason: null,
  sentAt: '2026-08-10T08:05:00.000Z',
  createdAt: '2026-08-10T08:05:00.000Z',
};

function renderRuns(messages: readonly MessageResponse[]) {
  const runs = groupMessagesIntoRuns(messages);

  return render(
    <ToastProvider>
      <ol>
        {runs.map((run) => (
          <MessageRun key={run.key} run={run} contactName={CONTACT} senderNames={NAMES} />
        ))}
      </ol>
    </ToastProvider>,
  );
}

describe('MessageRun', () => {
  it('serves three consecutive messages from one sender with one label', () => {
    renderRuns([
      { ...BASE, id: 'a', body: 'Hello', sentAt: '2026-08-10T08:05:00.000Z' },
      { ...BASE, id: 'b', body: 'Are you there?', sentAt: '2026-08-10T08:05:20.000Z' },
      { ...BASE, id: 'c', body: 'It is urgent', sentAt: '2026-08-10T08:05:40.000Z' },
    ]);

    expect(screen.getAllByText(CONTACT)).toHaveLength(1);
    // One channel tag too: it belonged to every bubble before TAR-518.
    expect(screen.getAllByText(content.channels.whatsapp)).toHaveLength(1);
    expect(screen.getByText('It is urgent')).toBeInTheDocument();
  });

  it('says which way a message went, in text and not only by the side it is on', () => {
    renderRuns([
      { ...BASE, id: 'a' },
      {
        ...BASE,
        id: 'b',
        direction: 'outbound',
        origin: 'agent',
        sentByUserId: AGENT_ID,
        sentAt: '2026-08-10T08:06:00.000Z',
      },
    ]);

    expect(screen.getByText(content.thread.inbound)).toBeInTheDocument();
    expect(screen.getByText(content.thread.outbound)).toBeInTheDocument();
  });

  it('names the agent who sent an outbound run', () => {
    renderRuns([
      {
        ...BASE,
        direction: 'outbound',
        origin: 'agent',
        body: 'On its way.',
        sentByUserId: AGENT_ID,
      },
    ]);

    expect(screen.getByText('Amina Haddad')).toBeInTheDocument();
  });

  it('names the chatbot rather than automation in general', () => {
    // `origin` is the narrower answer, and the only one that says *which* system
    // replied: a workflow (TAR-27) also sends with no sender, and an agent
    // deciding whether to take a thread over needs to know which it was.
    renderRuns([
      { ...BASE, direction: 'outbound', origin: 'bot', sentByAutomation: true, body: 'Hi!' },
    ]);

    expect(screen.getByText(content.thread.senderBot)).toBeInTheDocument();
    expect(screen.queryByText(content.thread.senderAutomation)).toBeNull();
  });

  it('says a non-chatbot automated send came from automation', () => {
    renderRuns([
      {
        ...BASE,
        direction: 'outbound',
        origin: 'system',
        sentByAutomation: true,
        body: 'Your ticket was closed.',
      },
    ]);

    expect(screen.getByText(content.thread.senderAutomation)).toBeInTheDocument();
  });

  it('does not attribute a human’s reply to automation when their name is unresolved', () => {
    // The directory read is one page of users, so an agent past it resolves to
    // no name. Reading that as "a bot wrote this" misattributes a colleague's
    // words.
    renderRuns([
      {
        ...BASE,
        direction: 'outbound',
        origin: 'agent',
        body: 'Looking into it now.',
        sentByUserId: '0192f001-0000-7000-8000-000000000199',
      },
    ]);

    expect(screen.getByText(content.thread.senderTeammate)).toBeInTheDocument();
    expect(screen.queryByText(content.thread.senderAutomation)).toBeNull();
  });

  it('trusts the origin over a name that happens to resolve', () => {
    renderRuns([
      {
        ...BASE,
        direction: 'outbound',
        origin: 'bot',
        sentByAutomation: true,
        sentByUserId: AGENT_ID,
        body: 'Auto-reply.',
      },
    ]);

    expect(screen.getByText(content.thread.senderBot)).toBeInTheDocument();
    expect(screen.queryByText('Amina Haddad')).toBeNull();
  });
});
