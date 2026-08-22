'use client';

import { forwardRef, type CSSProperties, type InputHTMLAttributes } from 'react';
import { cx } from '@/lib/cx';
import styles from './Slider.module.css';

/**
 * A value picked from a continuous range, with the value written out beside it.
 * Usage:
 *
 * ```tsx
 * <Slider
 *   min={0} max={1} step={0.05} value={0.6}
 *   onChange={setValue}
 *   valueLabel="60% sure"
 * />
 * ```
 *
 * **A native `<input type="range">` under a designed face**, the same trade
 * `Select` makes. Arrow keys step, Page Up/Down jump, Home and End go to the
 * ends, and a touch device gets its own drag behaviour — all of it the
 * platform's, none of it re-implemented. What is replaced is only the browser's
 * painting: the OS track and thumb are the loudest piece of foreign chrome a
 * settings screen can carry.
 *
 * `valueLabel` does two jobs and must read as a sentence rather than a number:
 * it is the `<output>` beside the control **and** the `aria-valuetext`, so a
 * screen reader hears "60 percent sure" on every arrow press rather than "0.6".
 *
 * The filled portion is drawn by a sibling rather than by a gradient on the
 * input, so it is positioned with logical properties and follows the control
 * when the page reads right to left.
 */

export interface SliderProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'type' | 'value' | 'onChange' | 'children'
> {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  /** The current value as a sentence — the `<output>` text and `aria-valuetext`. */
  valueLabel: string;
  /** Pairs the `<output>` with its control; pass `Field`'s `controlId`. */
  id: string;
}

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { value, min, max, step, onChange, valueLabel, id, className, ...rest },
  ref,
) {
  /*
   * Guards a `min === max` range, which would otherwise divide by zero and
   * paint the fill `NaN` wide. Clamped as well as guarded: a stored value from
   * outside the range draws a full or empty track rather than one that escapes.
   */
  const span = max - min;
  const ratio = span === 0 ? 0 : Math.min(1, Math.max(0, (value - min) / span));

  return (
    <div className={cx(styles.slider, className)}>
      <span className={styles.control}>
        <span
          aria-hidden="true"
          className={styles.track}
          style={{ '--slider-ratio': ratio } as CSSProperties}
        >
          <span className={styles.fill} />
        </span>
        <input
          {...rest}
          ref={ref}
          id={id}
          type="range"
          className={styles.range}
          min={min}
          max={max}
          step={step}
          value={value}
          aria-valuetext={valueLabel}
          onChange={(event) => {
            onChange(Number(event.target.value));
          }}
        />
      </span>
      {/* Not a live region: the input announces its own `aria-valuetext` on every
          change, and a polite region would say the same thing a second time. */}
      <output className={styles.value} htmlFor={id}>
        {valueLabel}
      </output>
    </div>
  );
});
