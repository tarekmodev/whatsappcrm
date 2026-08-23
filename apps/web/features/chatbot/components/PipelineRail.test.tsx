import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { content } from '@/content/en';
import { SectionCard } from '@/components/ui/SectionCard';
import type { AiConfigResponse } from '@whatsappcrm/contracts';
import type { SourceHealth } from '../chatbot.data';
import { CHATBOT_SECTION_IDS } from '../constants';
import { chatbotPipeline } from '../pipeline';
import { PipelineRail } from './PipelineRail';

/**
 * What the rail has to be to a reader who is not looking at the colours.
 *
 * The dots and the connectors are the diagram, and they are the half of it a
 * screen reader, a forced-colors user and anybody who cannot separate amber from
 * green never gets. Everything asserted here is the other half: each link's name
 * carries the label, the state and whether the flow stops there — and activating
 * one lands the reader inside the card they picked rather than at the top of the
 * page they left.
 */

const CONFIG: AiConfigResponse = {
  isEnabled: false,
  model: null,
  minConfidence: 0.6,
  maxBotTurns: 5,
  systemPrompt: null,
  handoffMessage: null,
  handoffKeywords: [],
  availableModels: [],
  readiness: { ready: false, indexedDocumentCount: 14, blockers: ['disabled'] },
  updatedAt: '2026-08-01T09:05:00.000Z',
};

const HEALTH: SourceHealth = {
  readyCount: 14,
  indexingCount: 0,
  failedCount: 0,
  isIndexingCapped: false,
  isFailedCapped: false,
};

function renderRail() {
  const pipeline = chatbotPipeline(content, CONFIG, HEALTH);

  return render(
    <>
      <PipelineRail stages={pipeline.stages} />
      <SectionCard
        id={CHATBOT_SECTION_IDS.eligibility}
        title={content.chatbot.eligibilityHeading}
        description={content.chatbot.eligibilityDescription}
      >
        <p>The rules.</p>
      </SectionCard>
    </>,
  );
}

describe('PipelineRail', () => {
  it('is an ordered list of four links, because the order is the claim', () => {
    renderRail();

    const rail = screen.getByRole('navigation', { name: content.chatbot.railLabel });

    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(rail.querySelector('ol')).not.toBeNull();
  });

  it('says the state in each link’s own name, not only in its dot', () => {
    renderRail();

    expect(
      screen.getByRole('link', {
        name: content.chatbot.stageLinkNameBlocking(
          content.chatbot.stages.eligibility,
          content.chatbot.stageEligibilityOff,
        ),
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('link', {
        name: content.chatbot.stageLinkName(
          content.chatbot.stages.sources,
          content.chatbot.stageSourcesReady(14),
        ),
      }),
    ).toBeInTheDocument();
  });

  it('moves focus into the card it links to', async () => {
    // A fragment link scrolls a heading into view without focusing it, which
    // leaves a keyboard reader at the top of the page they just left. The
    // heading carries `tabindex="-1"` for exactly this.
    //
    // `findBy`, because the focus is deferred a task: a real browser resets
    // focus to the body as part of the link's default action, *after* this
    // handler runs. jsdom implements neither the navigation nor the reset, so
    // what this asserts is that focus lands — that it also *survives* was
    // verified in Chromium, and cannot be asserted here.
    renderRail();

    fireEvent.click(
      screen.getByRole('link', {
        name: content.chatbot.stageLinkNameBlocking(
          content.chatbot.stages.eligibility,
          content.chatbot.stageEligibilityOff,
        ),
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: content.chatbot.eligibilityHeading }),
      ).toHaveFocus();
    });
  });

  it('points each link at its own card', () => {
    renderRail();

    const links = screen.getAllByRole('link');

    expect(links.map((link) => link.getAttribute('href'))).toEqual([
      `#${CHATBOT_SECTION_IDS.sources}`,
      `#${CHATBOT_SECTION_IDS.eligibility}`,
      `#${CHATBOT_SECTION_IDS.confidence}`,
      `#${CHATBOT_SECTION_IDS.handoff}`,
    ]);
  });
});
