'use client';

import { useState, type Ref } from 'react';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import styles from './PasswordField.module.css';

/**
 * A password input with a show/hide toggle. Usage:
 * `<PasswordField label={…} value={password} onChange={setPassword} autoComplete="new-password" />`.
 *
 * Extracted the moment sign-in and invite acceptance both needed it, and used by
 * TAR-61's reset screens too. The toggle is the reason it is one component
 * rather than two `<Field>` blocks: a password the user can read back is what
 * makes a 12-character minimum typeable on a phone, and getting its accessible
 * name and pressed state right once is better than three times.
 */

export interface PasswordFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  /**
   * `current-password` when signing in, `new-password` when setting one — the
   * difference is what tells a password manager whether to offer to save it.
   */
  autoComplete: 'current-password' | 'new-password';
  error?: string;
  hint?: string;
  /** So a form can move focus here when this is the first invalid field. */
  inputRef?: Ref<HTMLInputElement>;
}

export function PasswordField({
  label,
  value,
  onChange,
  autoComplete,
  error,
  hint,
  inputRef,
}: PasswordFieldProps) {
  const content = useContent();
  const [isVisible, setIsVisible] = useState(false);

  return (
    <Field label={label} hint={hint} error={error} isRequired>
      {({ controlId, describedBy, isInvalid }) => (
        <div className={styles.wrapper}>
          <TextInput
            id={controlId}
            ref={inputRef}
            className={styles.input}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            type={isVisible ? 'text' : 'password'}
            name="password"
            autoComplete={autoComplete}
            autoCapitalize="off"
            spellCheck={false}
            value={value}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            className={styles.toggle}
            // The visible word is the short one; the accessible name is the full
            // phrase and contains it, which is what WCAG 2.5.3 asks for.
            aria-label={isVisible ? content.auth.hidePasswordAria : content.auth.showPasswordAria}
            aria-pressed={isVisible}
            aria-controls={controlId}
            onClick={() => {
              setIsVisible((current) => !current);
            }}
          >
            {isVisible ? content.auth.hidePassword : content.auth.showPassword}
          </Button>
        </div>
      )}
    </Field>
  );
}
