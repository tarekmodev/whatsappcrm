import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Field } from './Field';
import { TextInput } from './TextInput';

/**
 * `Field` is where label / hint / error wiring happens once for the whole app, so
 * it is tested thoroughly here rather than re-tested on every form that uses it.
 */
describe('Field', () => {
  it('binds the label to the control', () => {
    render(<Field label="Email address">{({ controlId }) => <TextInput id={controlId} />}</Field>);

    expect(screen.getByLabelText('Email address')).toBeInTheDocument();
  });

  it('describes the control with the hint', () => {
    render(
      <Field label="Team name" hint="Shown to every member">
        {({ controlId, describedBy }) => (
          <TextInput id={controlId} aria-describedby={describedBy} />
        )}
      </Field>,
    );

    expect(screen.getByLabelText('Team name')).toHaveAccessibleDescription('Shown to every member');
  });

  it('marks the control invalid and links the error message', () => {
    render(
      <Field label="Email address" error="Enter a valid email address">
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput id={controlId} aria-describedby={describedBy} aria-invalid={isInvalid} />
        )}
      </Field>,
    );

    const input = screen.getByLabelText('Email address');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('Enter a valid email address');
  });

  it('describes the control with both the hint and the error when both are present', () => {
    render(
      <Field label="Email address" hint="Work address" error="Required">
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput id={controlId} aria-describedby={describedBy} aria-invalid={isInvalid} />
        )}
      </Field>,
    );

    expect(screen.getByLabelText('Email address')).toHaveAccessibleDescription(
      'Work address Required',
    );
  });

  it('keeps a hidden label available to assistive technology', () => {
    render(
      <Field label="Search agents" isLabelHidden>
        {({ controlId }) => <TextInput id={controlId} type="search" />}
      </Field>,
    );

    // Visually hidden, but still the control's accessible name.
    expect(screen.getByLabelText('Search agents')).toBeInTheDocument();
  });
});
