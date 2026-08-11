'use client';

import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';

/**
 * One password input, wired to its label, hint and error. Usage:
 *
 * ```tsx
 * <PasswordField label={…} autoComplete="new-password" value={password}
 *                error={errors.password} onChange={setPassword} />
 * ```
 *
 * Four of these appear across the reset and change screens, which is three too
 * many to hand-assemble. The reason it is a component rather than a repeated
 * `Field` block is `autoComplete`: a password manager saves the wrong thing, or
 * nothing, when `current-password` and `new-password` are mixed up, and making it
 * a required prop is what stops that being a per-form decision.
 */

/** The three values a password manager understands. Nothing else belongs here. */
export type PasswordAutoComplete = 'current-password' | 'new-password' | 'off';

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: PasswordAutoComplete;
  error?: string;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint} error={error} isRequired>
      {({ controlId, describedBy, isInvalid }) => (
        <TextInput
          id={controlId}
          aria-describedby={describedBy}
          aria-invalid={isInvalid}
          type="password"
          autoComplete={autoComplete}
          // `off` on all of them: a browser that helpfully corrects a password is
          // a browser that submits a password the user did not type.
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </Field>
  );
}
