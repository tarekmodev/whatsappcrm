import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HandoffContextResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { HandoffPanel } from './HandoffPanel';

/**
 * TAR-28's second acceptance criterion: on handoff the human agent gets the
 * chatbot's context.
 *
 * The exchange itself is the thread's job — a bot reply is an ordinary message
 * row — so what is asserted here is what the transcript cannot carry: why the
 * chatbot stopped, how sure it was, and which entries it answered from.
 */

function handoff(overrides: Partial<HandoffContextResponse> = {}): HandoffContextResponse {
  return {
    conversationId: '0192f004-0000-7000-8000-000000000405',
    ticketId: null,
    reason: 'low_confidence',
    triggerMessageId: '0192f006-0000-7000-8000-000000000625',
    triggerMessageBody: 'And if the box was already opened?',
    botExchange: [],
    botEngagedAt: '2026-08-10T10:00:12.000Z',
    handedOffAt: '2026-08-10T10:06:01.000Z',
    botReplyCount: 2,
    confidence: {
      score: 0.3,
      modelConfidence: 0.6,
      retrievalScore: 0.3,
      modelReason: 'ambiguous',
    },
    citedDocuments: [
      { id: '0192f010-0000-7000-8000-000000001001', title: 'Returns and refunds policy' },
    ],
    ...overrides,
  };
}

describe('HandoffPanel', () => {
  it('says why the chatbot stopped', () => {
    render(<HandoffPanel handoff={handoff()} />);

    expect(screen.getByText(content.inbox.handoffReasons.low_confidence)).toBeInTheDocument();
  });

  it('quotes the message the chatbot could not take', () => {
    render(<HandoffPanel handoff={handoff()} />);

    expect(screen.getByText('And if the box was already opened?')).toBeInTheDocument();
  });

  it('names the knowledge base entries it answered from', () => {
    // The field that catches a confident wrong answer: the customer asked about
    // shipping and the bot answered from the refunds policy.
    render(<HandoffPanel handoff={handoff()} />);

    expect(screen.getByText('Returns and refunds policy')).toBeInTheDocument();
  });

  it('says so when it cited nothing', () => {
    render(<HandoffPanel handoff={handoff({ citedDocuments: [] })} />);

    expect(screen.getByText(content.inbox.handoffCitedNone)).toBeInTheDocument();
  });

  it('shows both halves of the composite score, not only the total', () => {
    // The composite is a `min`, so "30% sure" alone does not say whether the
    // knowledge base was thin or the model hedged — and the fix differs.
    render(<HandoffPanel handoff={handoff()} />);

    expect(
      screen.getByText(content.inbox.handoffConfidenceBreakdown('60%', '30%')),
    ).toBeInTheDocument();
  });

  it('explains a missing score rather than rendering a blank', () => {
    // On a keyword handoff the model was never called, so there is no number —
    // and a dash there would read as data that failed to load.
    render(<HandoffPanel handoff={handoff({ reason: 'customer_requested', confidence: null })} />);

    expect(screen.getByText(content.inbox.handoffConfidenceNone)).toBeInTheDocument();
  });
});
