import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { content } from '@/content/en';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { AuthForm } from './AuthForm';

/**
 * The four things TAR-521 moved into the shared form, tested here once rather
 * than on each of the five screens that inherit them: the required legend, the
 * pending state, where focus goes when a submit is rejected, and where it goes
 * when the fields are disabled underneath it.
 */

const LABEL = 'Email address';
const SUBMIT = 'Sign in';
const PENDING = 'Signing in…';

function Host({
  isPending = false,
  formError = null,
  onSubmit = () => {},
}: {
  isPending?: boolean;
  formError?: string | null;
  onSubmit?: () => void;
}) {
  const [error, setError] = useState<string | undefined>(undefined);

  return (
    <AuthForm
      submitLabel={SUBMIT}
      pendingLabel={PENDING}
      isPending={isPending}
      formError={formError}
      onSubmit={() => {
        setError(content.form.requiredFieldError);
        onSubmit();
      }}
    >
      <Field label={LABEL} error={error} isRequired>
        {({ controlId, describedBy, isInvalid }) => (
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            defaultValue=""
          />
        )}
      </Field>
    </AuthForm>
  );
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: SUBMIT }));
}

describe('AuthForm', () => {
  it('gives the required marker a key, so the asterisk beside a label means something', () => {
    render(<Host />);

    expect(screen.getByText(content.form.requiredLegend)).toBeInTheDocument();
  });

  it('moves focus to the first field a rejected submit marked invalid', () => {
    render(<Host />);

    submit();

    expect(fieldByLabel(LABEL)).toHaveFocus();
  });

  it('says what it is doing and disables the fields while the request is in flight', () => {
    render(<Host isPending />);

    expect(screen.getByRole('button', { name: PENDING })).toBeInTheDocument();
    // Disabled, not hidden: typing into a field whose value has already been sent
    // is a change that silently does not count.
    expect(fieldByLabel(LABEL)).toBeDisabled();
  });

  it('keeps the submit focusable while pending, so focus is not dropped to the body', () => {
    const { rerender } = render(<Host />);

    fieldByLabel(LABEL).focus();
    rerender(<Host isPending />);

    expect(screen.getByRole('button', { name: PENDING })).toHaveFocus();
  });

  it('announces a failure and takes focus to it', () => {
    const message = content.auth.invalidCredentialsError;

    render(<Host formError={message} />);

    const alert = screen.getByRole('alert');

    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveFocus();
  });

  it('does not submit twice when the pending button is pressed again', () => {
    const onSubmit = vi.fn();

    render(<Host isPending onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole('button', { name: PENDING }));

    expect(onSubmit).not.toHaveBeenCalled();
  });
});
