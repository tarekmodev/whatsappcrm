import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Field } from './Field';
import { SettingsForm, SettingsFormActions, SettingsFormSection } from './SettingsForm';
import { TextInput } from './TextInput';

/**
 * The settings-form layout reaches its fields through context rather than
 * through a prop, which is the part that can silently stop working: a `Field`
 * two components deep — `ModelChoiceField`, `ConfidenceField` — still belongs to
 * the form's layout, and a prop threaded through each of them is a prop one of
 * them ends up missing (TAR-710).
 *
 * `data-layout` is asserted rather than a class name because it is the published
 * hook the stylesheet keys on; the widths it produces are a browser
 * measurement, not a jsdom one.
 */

/** A field wrapped twice over, standing in for the real feature components. */
function NestedField() {
  return (
    <div>
      <Field label="Model" hint="A faster model costs less per reply">
        {({ controlId, describedBy }) => (
          <TextInput id={controlId} aria-describedby={describedBy} />
        )}
      </Field>
    </div>
  );
}

describe('SettingsForm', () => {
  it('puts every field it contains into the split layout, however deep', () => {
    render(
      <SettingsForm>
        <SettingsFormSection>
          <NestedField />
        </SettingsFormSection>
      </SettingsForm>,
    );

    expect(screen.getByLabelText('Model').closest('[data-layout]')).toHaveAttribute(
      'data-layout',
      'split',
    );
  });

  it('leaves a field outside it stacked', () => {
    // The default, which every dialog and filter bar in the app relies on.
    render(<NestedField />);

    expect(screen.getByLabelText('Model').closest('[data-layout]')).toHaveAttribute(
      'data-layout',
      'stacked',
    );
  });

  it('submits without the browser validating it first', () => {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => {
      event.preventDefault();
    });

    render(
      <SettingsForm onSubmit={onSubmit}>
        <SettingsFormActions>
          <button type="submit">Save changes</button>
        </SettingsFormActions>
      </SettingsForm>,
    );

    // `noValidate` is the form's, not each caller's: the app reports through
    // `Field`, and a native bubble is a message no theme reaches.
    expect(screen.getByRole('button', { name: 'Save changes' }).closest('form')).toHaveAttribute(
      'noValidate',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(onSubmit).toHaveBeenCalled();
  });

  it('renders the skeleton layout without a form to submit', () => {
    render(
      <SettingsForm as="div">
        <SettingsFormSection>
          <NestedField />
        </SettingsFormSection>
      </SettingsForm>,
    );

    expect(screen.queryByRole('form')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Model').closest('[data-layout]')).toHaveAttribute(
      'data-layout',
      'split',
    );
  });
});
