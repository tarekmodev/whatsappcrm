import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { ConfidenceBand } from './ConfidenceBand';

/**
 * The band repaints the rail; it must not have added a control, and it must not
 * have taken the sentence away.
 *
 * The two region labels are the visualisation and they are decoration: announcing
 * them would turn one value into three things to listen to. What a screen reader
 * hears on every arrow press is still `aria-valuetext` — "60% sure" — exactly as
 * it was before the band existed (TAR-710).
 *
 * jsdom implements no key handling for a range input, so stepping is verified in
 * a browser rather than pretended at here.
 */

function renderBand(value = 0.6, onChange = vi.fn(), isDisabled = false) {
  render(<ConfidenceBand value={value} onChange={onChange} isDisabled={isDisabled} />);

  return onChange;
}

describe('ConfidenceBand', () => {
  it('is one control, and it is the native range', () => {
    renderBand();

    const slider = screen.getByRole('slider', { name: content.chatbot.confidenceLabel });

    expect(screen.getAllByRole('slider')).toHaveLength(1);
    expect(slider).toHaveAttribute('type', 'range');
  });

  it('reads out the judgement rather than the raw value', () => {
    renderBand();

    expect(screen.getByRole('slider')).toHaveAttribute(
      'aria-valuetext',
      content.chatbot.confidenceValue('60%'),
    );
  });

  it('reports the number back, not the event', () => {
    const onChange = renderBand();

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.75' } });

    expect(onChange).toHaveBeenCalledWith(0.75);
  });

  it('says that confidence is the lower of two numbers, where the choice is made', () => {
    // `compositeConfidence` is `min(model, retrieval)` by design. An admin who
    // reads it as an average tunes the threshold in the wrong direction, and this
    // caption is the only place the console says otherwise.
    renderBand();

    expect(screen.getByText(content.chatbot.confidenceCaption)).toBeInTheDocument();
  });

  it('keeps the threshold readable when it cannot be changed', () => {
    // A read-only principal still has to be able to see where the line sits —
    // greying the number along with the control is how a read-only page stops
    // telling anybody anything.
    renderBand(0.75, vi.fn(), true);

    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByText(content.chatbot.confidenceValue('75%'))).toBeInTheDocument();
  });
});
