'use client';

import { forwardRef, type InputHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Switch.module.css';

/**
 * The on/off control for a setting that takes effect on its own. Usage:
 * `<Switch isChecked={isEnabled} onChange={setIsEnabled} stateLabel="On" />`,
 * always inside a `Field` so the label and hint are wired for it.
 *
 * **A native checkbox wearing a switch's face.** The element stays an
 * `<input type="checkbox">` — so `<label for>` activates it, Space toggles it,
 * and the form's own reset and autofill still reach it — and takes `role="switch"`,
 * which is what changes the announcement from "checkbox, checked" to
 * "switch, on". Everything replaced is the browser's painting of it.
 *
 * **A switch, not a checkbox, is the right control here** and the two are not
 * interchangeable: a checkbox proposes a change that a submit later commits,
 * while a switch reads as the mode the thing is in right now. Use `Checkbox`
 * for a genuine multi-select or a consent tick.
 *
 * `stateLabel` is the state in words beside the track, and it is required rather
 * than optional: a knob's position is the only other carrier, and position alone
 * fails in forced-colors mode and for anyone reading at 200%. It is
 * `aria-hidden` because `role="switch"` already announces the state — otherwise
 * a screen reader says it twice.
 */

export interface SwitchProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'role' | 'checked' | 'onChange' | 'children'
> {
  isChecked: boolean;
  onChange: (isChecked: boolean) => void;
  /** "On" / "Off", from the content layer. Shown beside the track. */
  stateLabel: string;
}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(function Switch(
  { isChecked, onChange, stateLabel, className, ...rest },
  ref,
) {
  return (
    <span className={cx(styles.switch, className)}>
      <span className={styles.control}>
        <input
          {...rest}
          ref={ref}
          type="checkbox"
          role="switch"
          className={styles.input}
          checked={isChecked}
          // Redundant with `checked` — which ARIA in HTML already maps onto this
          // role — and written anyway, so the state is legible in the DOM to
          // anyone auditing the page rather than only to the accessibility tree.
          aria-checked={isChecked}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
        />
        <span className={styles.knob} aria-hidden="true" />
      </span>
      <span className={styles.state} aria-hidden="true">
        {stateLabel}
      </span>
    </span>
  );
});
