'use client';

import { useId, useState } from 'react';
import { Field } from '@/components/ui/Field';
import { Icon } from '@/components/ui/Icon';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import { PasswordRequirements } from './PasswordRequirements';
import styles from './PasswordField.module.css';

/**
 * One password input, wired to its label, hint, error and reveal control. Usage:
 *
 * ```tsx
 * <PasswordField label={…} autoComplete="new-password" value={password}
 *                error={errors.password} hasRequirements onChange={setPassword} />
 * ```
 *
 * Four of these appear across the reset and change screens, which is three too
 * many to hand-assemble. The reason it is a component rather than a repeated
 * `Field` block is `autoComplete`: a password manager saves the wrong thing, or
 * nothing, when `current-password` and `new-password` are mixed up, and making it
 * a required prop is what stops that being a per-form decision.
 *
 * ## The reveal control
 *
 * A password field with no way to see what was typed is a field people retype
 * three times and then abandon, and it is worst on exactly the screens that
 * matter here — a phone keyboard, a long passphrase, no second chance. The
 * control is a real button inside the input's trailing edge, and its accessible
 * name says what pressing it will do *now* rather than what state the field is in
 * (TAR-521).
 *
 * It is never on by default and does not survive a remount: revealing is a
 * deliberate act, and a field that came back revealed after a navigation would
 * put somebody's password on a screen they had stopped looking at.
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
  hasRequirements = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: PasswordAutoComplete;
  error?: string;
  hint?: string;
  /**
   * Shows the live policy checklist below the control. For a password being
   * *set* — reset, change, invite — where the rules are something to satisfy
   * rather than something to recall; never on a `current-password` field, whose
   * value has to obey whatever policy was in force when it was chosen.
   */
  hasRequirements?: boolean;
}) {
  const content = useContent();
  const requirementsId = useId();
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <Field label={label} hint={hint} error={error} isRequired>
      {({ controlId, describedBy, isInvalid }) => (
        <>
          <div className={styles.control}>
            <TextInput
              id={controlId}
              className={styles.input}
              aria-describedby={
                [describedBy, hasRequirements ? requirementsId : null]
                  .filter((value): value is string => value !== null && value !== undefined)
                  .join(' ') || undefined
              }
              aria-invalid={isInvalid}
              type={isRevealed ? 'text' : 'password'}
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
            <button
              type="button"
              className={styles.reveal}
              // Not `aria-pressed`: the name already changes with the state, and a
              // toggle that announces both says "Hide password, pressed" — one of
              // which is always wrong.
              aria-label={isRevealed ? content.auth.hidePassword : content.auth.showPassword}
              aria-controls={controlId}
              onClick={() => {
                setIsRevealed((current) => !current);
              }}
            >
              <Icon name={isRevealed ? 'eyeOff' : 'eye'} size="sm" />
            </button>
          </div>
          {hasRequirements ? <PasswordRequirements id={requirementsId} value={value} /> : null}
        </>
      )}
    </Field>
  );
}
