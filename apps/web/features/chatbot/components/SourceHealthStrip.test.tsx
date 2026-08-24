import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { routes } from '@/lib/routes';
import type { SourceHealth } from '../chatbot.data';
import type { KnowledgeListParams } from '../knowledge-params';
import { SourceHealthStrip } from './SourceHealthStrip';

/**
 * Three figures and what they are allowed to claim.
 *
 * The `Ready` count is exact — the readiness payload publishes it. The other two
 * are read one page at a time, so a tenant past the page size gets `100+` rather
 * than a number nobody measured. Printing `100` there would be the console
 * inventing a total no endpoint returns.
 */

function health(overrides: Partial<SourceHealth> = {}): SourceHealth {
  return {
    readyCount: 14,
    indexingCount: 2,
    failedCount: 0,
    isIndexingCapped: false,
    isFailedCapped: false,
    ...overrides,
  };
}

const UNFILTERED: KnowledgeListParams = { q: undefined, status: undefined };

describe('SourceHealthStrip', () => {
  it('names each figure with what it counts, in the order the eye reads them', () => {
    render(<SourceHealthStrip health={health()} filters={UNFILTERED} />);

    expect(
      screen.getByRole('link', {
        name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.indexed, '14'),
      }),
    ).toBeInTheDocument();
  });

  it('says `100+` rather than inventing a total nothing publishes', () => {
    render(
      <SourceHealthStrip
        health={health({ failedCount: 100, isFailedCapped: true })}
        filters={UNFILTERED}
      />,
    );

    expect(
      screen.getByRole('link', {
        name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.failed, '100+'),
      }),
    ).toBeInTheDocument();
  });

  it('keeps the search term when a tile narrows by status', () => {
    // A status picked while a search is on has to narrow that search rather than
    // replace it — otherwise the tile is a way of losing your place.
    render(<SourceHealthStrip health={health()} filters={{ q: 'refunds', status: undefined }} />);

    expect(
      screen.getByRole('link', {
        name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.failed, '0'),
      }),
    ).toHaveAttribute('href', routes.settingsChatbot({ q: 'refunds', status: 'failed' }));
  });

  it('marks the filter the view is already on', () => {
    // `aria-current`, which is `FilterPills`' convention rather than a new one —
    // and the reason the tile does not also say "currently filtering" in words.
    render(<SourceHealthStrip health={health()} filters={{ q: undefined, status: 'pending' }} />);

    const current = screen.getByRole('link', {
      name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.pending, '2'),
    });

    expect(current).toHaveAttribute('aria-current', 'page');
    expect(
      screen.getByRole('link', {
        name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.indexed, '14'),
      }),
    ).not.toHaveAttribute('aria-current');
  });

  it('leaves a zero tile a link, so it is still the way to ask the question', () => {
    render(<SourceHealthStrip health={health()} filters={UNFILTERED} />);

    expect(
      screen.getByRole('link', {
        name: content.chatbot.sourceHealthTileName(content.chatbot.statuses.failed, '0'),
      }),
    ).toHaveAttribute('href', routes.settingsChatbot({ status: 'failed' }));
  });
});
