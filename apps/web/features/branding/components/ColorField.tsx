'use client';

import { Field } from '@/components/ui/Field';
import { TextInput } from '@/components/ui/TextInput';
import { useContent } from '@/lib/content';
import styles from './ColorField.module.css';

/**
 * One brand colour: a native colour picker beside the hex value, both editing the
 * same string. Usage:
 * `<ColorField label={…} hint={…} value={value} error={error} onChange={setValue} />`.
 *
 * Two controls rather than one, because neither alone is enough. The native
 * `<input type="color">` opens the platform picker — including the eyedropper —
 * but exposes its value to a screen reader as an opaque swatch and cannot be
 * typed into. The text field is what makes a brand hex from a style guide
 * enterable, pasteable and readable. They are wired to one value, so changing
 * either moves the other.
 *
 * The colour input is `aria-hidden` and out of the tab order: it would otherwise
 * be a second, unlabelled stop announcing the same value the text field already
 * carries. Everything it can do, the text field can do — so nothing is lost by
 * keyboard, and a mouse user still gets the picker.
 */

export interface ColorFieldProps {
  label: string;
  hint: string;
  /** Always `#rrggbb`; the picker cannot represent anything else. */
  value: string;
  error?: string;
  onChange: (value: string) => void;
}

export function ColorField({ label, hint, value, error, onChange }: ColorFieldProps) {
  const content = useContent();

  return (
    <Field label={content.branding.hexLabel(label)} hint={hint} error={error}>
      {({ controlId, describedBy, isInvalid }) => (
        <div className={styles.row}>
          <input
            type="color"
            className={styles.swatch}
            // The text field is the labelled, focusable control for this value.
            aria-hidden="true"
            tabIndex={-1}
            value={isPickerSafe(value) ? value : FALLBACK_SWATCH}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
          <TextInput
            id={controlId}
            aria-describedby={describedBy}
            aria-invalid={isInvalid}
            className={styles.hex}
            value={value}
            spellCheck={false}
            autoCapitalize="none"
            autoCorrect="off"
            inputMode="text"
            maxLength={HEX_LENGTH}
            onChange={(event) => {
              onChange(event.target.value);
            }}
          />
        </div>
      )}
    </Field>
  );
}

/** `#rrggbb` and nothing else. */
const HEX_LENGTH = 7;
const PICKER_SAFE = /^#[0-9a-fA-F]{6}$/;

/**
 * What the swatch shows while the text field holds something the picker cannot
 * parse — mid-typing, or after a paste of `rgb(…)`. A neutral grey rather than
 * black, so a half-typed value does not look like a deliberate choice; the text
 * field's own error is what says the value is wrong.
 */
const FALLBACK_SWATCH = '#94a3b8';

function isPickerSafe(value: string): boolean {
  return PICKER_SAFE.test(value);
}
