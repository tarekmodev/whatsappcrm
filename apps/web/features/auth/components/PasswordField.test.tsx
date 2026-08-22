import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AUTH_POLICY } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { fieldByLabel } from '@/lib/testing/field-queries';
import { PasswordField } from './PasswordField';

/**
 * The reveal control and the live policy checklist (TAR-521), on the one
 * component every password on every auth screen is built from — so this is tested
 * once here rather than four times across the flows that use it.
 */

const LABEL = content.auth.newPasswordLabel;

/** A controlled host, because the field is controlled and the checklist reads the value. */
function Host({ hasRequirements = false }: { hasRequirements?: boolean }) {
  const [value, setValue] = useState('');

  return (
    <PasswordField
      label={LABEL}
      autoComplete="new-password"
      hasRequirements={hasRequirements}
      value={value}
      onChange={setValue}
    />
  );
}

function type(value: string): void {
  fireEvent.change(fieldByLabel(LABEL), { target: { value } });
}

describe('PasswordField', () => {
  it('hides the password until the reveal control is pressed, and says which it will do', () => {
    render(<Host />);

    expect(fieldByLabel(LABEL)).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByRole('button', { name: content.auth.showPassword }));

    expect(fieldByLabel(LABEL)).toHaveAttribute('type', 'text');
    // The name reflects what pressing it does *now*, not the state it is in.
    expect(screen.queryByRole('button', { name: content.auth.showPassword })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: content.auth.hidePassword }));

    expect(fieldByLabel(LABEL)).toHaveAttribute('type', 'password');
  });

  it('leaves the control pointing at the input it reveals', () => {
    render(<Host />);

    expect(screen.getByRole('button', { name: content.auth.showPassword })).toHaveAttribute(
      'aria-controls',
      fieldByLabel(LABEL).id,
    );
  });

  it('renders no checklist unless the field is one where a password is being set', () => {
    render(<Host />);

    expect(screen.queryByRole('list', { name: content.auth.passwordRequirementsLabel })).toBeNull();
  });

  it('ticks each rule as it is satisfied, and says so in words as well as in colour', () => {
    render(<Host hasRequirements />);

    const minimum = content.auth.passwordMinRequirement(AUTH_POLICY.passwordMinLength);

    expect(screen.getByText(minimum, { exact: false })).toHaveTextContent(
      content.form.requirementUnmet,
    );

    type('correct horse battery staple');

    expect(screen.getByText(minimum, { exact: false })).toHaveTextContent(
      content.form.requirementMet,
    );
  });

  it('un-ticks the upper bound rather than silently accepting a value the API will refuse', () => {
    render(<Host hasRequirements />);

    const maximum = content.auth.passwordMaxRequirement(AUTH_POLICY.passwordMaxLength);

    type('x'.repeat(AUTH_POLICY.passwordMaxLength + 1));

    expect(screen.getByText(maximum, { exact: false })).toHaveTextContent(
      content.form.requirementUnmet,
    );
  });

  it('describes the input with the checklist, so it is read on arriving at the field', () => {
    render(<Host hasRequirements />);

    const describedBy = fieldByLabel(LABEL).getAttribute('aria-describedby');
    const list = screen.getByRole('list', { name: content.auth.passwordRequirementsLabel });

    expect(describedBy?.split(' ')).toContain(list.id);
  });
});
