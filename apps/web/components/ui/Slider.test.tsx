import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Field } from './Field';
import { Slider } from './Slider';

/**
 * The slider keeps the native range's keyboard model — arrows, Page Up/Down,
 * Home and End — by keeping the native range, so what is worth asserting is what
 * the face could have broken: the label, the value **as a sentence**, and the
 * number the change reports back (TAR-710).
 *
 * jsdom implements no key handling for a range input, so stepping is verified in
 * the browser rather than pretended at here; a passing arrow-key assertion in
 * this environment would be asserting nothing.
 */

function renderSlider(value: number, onChange = vi.fn()) {
  render(
    <Field label="Confidence needed to reply" hint="Both the search and the model…">
      {({ controlId, describedBy }) => (
        <Slider
          id={controlId}
          aria-describedby={describedBy}
          min={0}
          max={1}
          step={0.05}
          value={value}
          valueLabel={`${Math.round(value * 100)}% sure`}
          onChange={onChange}
        />
      )}
    </Field>,
  );

  return onChange;
}

describe('Slider', () => {
  it('reads out the judgement rather than the raw value', () => {
    renderSlider(0.6);

    const control = screen.getByRole('slider', { name: 'Confidence needed to reply' });

    // What a screen reader says on every arrow press. "0.6" is the stored value
    // and tells an admin nothing about how sure "sure enough" is.
    expect(control).toHaveAttribute('aria-valuetext', '60% sure');
    expect(control).toHaveAccessibleDescription('Both the search and the model…');
  });

  it('shows the same sentence on screen, tied to the control', () => {
    renderSlider(0.6);

    expect(screen.getByText('60% sure')).toBeInTheDocument();
  });

  it('carries the range and the step it was given', () => {
    renderSlider(0.6);

    const control = screen.getByRole('slider');

    expect(control).toHaveAttribute('min', '0');
    expect(control).toHaveAttribute('max', '1');
    expect(control).toHaveAttribute('step', '0.05');
  });

  it('reports a number, not the input event string', () => {
    const onChange = renderSlider(0.6);

    fireEvent.change(screen.getByRole('slider'), { target: { value: '0.75' } });

    expect(onChange).toHaveBeenCalledWith(0.75);
  });
});
