import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Field } from './Field';
import { Switch } from './Switch';

/**
 * The two things a drawn control can lose when the platform stops painting it,
 * tested once here rather than on every screen that uses one: it must still
 * *be* a checkbox underneath — so a `<label for>` reaches it and the form's own
 * machinery still sees it — and it must still say which state it is in without
 * relying on the knob's position (TAR-710).
 */

function renderSwitch(isChecked: boolean, onChange = vi.fn()) {
  render(
    <Field label="Answer customers automatically" hint="Switch this off to send every…">
      {({ controlId, describedBy }) => (
        <Switch
          id={controlId}
          aria-describedby={describedBy}
          isChecked={isChecked}
          stateLabel={isChecked ? 'On' : 'Off'}
          onChange={onChange}
        />
      )}
    </Field>,
  );

  return onChange;
}

describe('Switch', () => {
  it('announces as a switch carrying its field label, hint and state', () => {
    renderSwitch(true);

    const control = screen.getByRole('switch', { name: 'Answer customers automatically' });

    expect(control).toBeChecked();
    expect(control).toHaveAttribute('aria-checked', 'true');
    expect(control).toHaveAccessibleDescription('Switch this off to send every…');
  });

  it('writes its state out beside the track', () => {
    renderSwitch(false);

    // Position is not the only carrier: forced-colors mode may not draw the
    // track at all, and a knob at one end says nothing on its own.
    expect(screen.getByText('Off')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeChecked();
  });

  it('reports the state it was flipped to', () => {
    const onChange = renderSwitch(false);

    fireEvent.click(screen.getByRole('switch'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('is still reached by its own label', () => {
    // The reason this is a native checkbox rather than a `<button role="switch">`:
    // `<label for>` only activates a labelable element, and `Field` writes one
    // for every control in the app.
    const onChange = renderSwitch(false);

    fireEvent.click(screen.getByText('Answer customers automatically'));

    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('passes a disabled state to the element that enforces it', () => {
    // Asserted on the control rather than by clicking it: jsdom dispatches a
    // click to a disabled input where a browser does not, so a behavioural
    // assertion here would be testing the environment rather than the component.
    render(
      <Field label="Answer customers automatically">
        {({ controlId }) => (
          <Switch id={controlId} isChecked disabled stateLabel="On" onChange={vi.fn()} />
        )}
      </Field>,
    );

    expect(screen.getByRole('switch')).toBeDisabled();
  });
});
