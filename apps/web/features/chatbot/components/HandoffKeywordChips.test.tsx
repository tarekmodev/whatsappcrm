import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { parseKeywords } from '../entry-form';
import { HandoffKeywordChips } from './HandoffKeywordChips';

/**
 * The gap this closes: an admin types comma- and newline-separated text into a
 * box, `parseKeywords` trims it, drops the blanks and drops the duplicates, and
 * until now nothing said what it had made of what they wrote.
 *
 * These assert the chips *are* the parse rather than a second rendering of the
 * text, and that removing one rewrites the box — which is what keeps the textarea
 * the input of record rather than one of two places the value lives.
 */

function renderChips(raw: string, onChange = vi.fn(), isDisabled = false) {
  render(
    <HandoffKeywordChips
      keywords={parseKeywords(raw)}
      onChange={onChange}
      isDisabled={isDisabled}
    />,
  );

  return onChange;
}

describe('HandoffKeywordChips', () => {
  it('shows what the parse made of the text, not the text', () => {
    // A trailing space and a repeated word both survive in the box and both
    // vanish on the way to the API. The chips are what will actually be saved.
    renderChips('agent \n\n human\nagent');

    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.getByText('human')).toBeInTheDocument();
  });

  it('rewrites the box when a chip is removed', () => {
    const onChange = renderChips('agent\nhuman\nperson');

    fireEvent.click(
      screen.getByRole('button', { name: content.chatbot.removeHandoffKeyword('human') }),
    );

    expect(onChange).toHaveBeenCalledWith('agent\nperson');
  });

  it('names each remove control after the word it removes', () => {
    // Three buttons all called "Remove" is three identical controls to a screen
    // reader, and no way to tell which one is which.
    renderChips('agent\nhuman');

    expect(
      screen.getByRole('button', { name: content.chatbot.removeHandoffKeyword('agent') }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: content.chatbot.removeHandoffKeyword('human') }),
    ).toBeInTheDocument();
  });

  it('offers no removal to a reader who may not write', () => {
    renderChips('agent', vi.fn(), true);

    expect(screen.getByText('agent')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('treats no words as a state rather than a problem', () => {
    // A workspace with no handoff words has not misconfigured anything — a
    // customer can still reach a person through an agent or a confidence drop.
    renderChips('   \n\n');

    expect(screen.getByText(content.chatbot.ruleKeywordsClauseEmpty)).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});
