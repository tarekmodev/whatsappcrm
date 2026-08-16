import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { AiReadiness } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { BotReadinessPanel } from './BotReadinessPanel';

/**
 * TAR-28's third acceptance criterion, in the console: a tenant with no
 * knowledge base is told, in as many words, that the chatbot is not answering
 * and why.
 *
 * ADR 0010 decision 4 makes the silence structural — with nothing indexed, no
 * request is made and no answer can be invented — and that is exactly why the
 * console has to say so. Silence and a broken feature look identical.
 */

function readiness(overrides: Partial<AiReadiness> = {}): AiReadiness {
  return { ready: true, indexedDocumentCount: 3, blockers: [], ...overrides };
}

describe('BotReadinessPanel', () => {
  it('says the chatbot is answering, and from how many entries', () => {
    render(<BotReadinessPanel readiness={readiness()} />);

    expect(screen.getByText(content.chatbot.readyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.readyBody(3))).toBeInTheDocument();
  });

  it('names an empty knowledge base as the reason automated replies are off', () => {
    render(
      <BotReadinessPanel
        readiness={readiness({
          ready: false,
          indexedDocumentCount: 0,
          blockers: ['no_indexed_documents'],
        })}
      />,
    );

    expect(screen.getByText(content.chatbot.notReadyHeading)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.blockers.no_indexed_documents)).toBeInTheDocument();
  });

  it('lists every blocker rather than only the first', () => {
    // An admin who clears one of three and still gets silence has learned
    // nothing, which is the whole reason the API returns an array.
    render(
      <BotReadinessPanel
        readiness={readiness({
          ready: false,
          indexedDocumentCount: 0,
          blockers: ['feature_not_in_plan', 'disabled', 'no_indexed_documents'],
        })}
      />,
    );

    expect(screen.getAllByRole('listitem')).toHaveLength(3);
    expect(screen.getByText(content.chatbot.blockers.feature_not_in_plan)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.blockers.disabled)).toBeInTheDocument();
    expect(screen.getByText(content.chatbot.blockers.no_indexed_documents)).toBeInTheDocument();
  });

  it('does not claim readiness from the document count alone', () => {
    // A tenant with indexed entries whose plan does not include the chatbot is
    // still not answering, and the count must not override that.
    render(
      <BotReadinessPanel
        readiness={readiness({
          ready: false,
          indexedDocumentCount: 4,
          blockers: ['feature_not_in_plan'],
        })}
      />,
    );

    expect(screen.queryByText(content.chatbot.readyHeading)).not.toBeInTheDocument();
    expect(screen.getByText(content.chatbot.notReadyHeading)).toBeInTheDocument();
  });
});
