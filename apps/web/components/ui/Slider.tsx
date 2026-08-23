'use client';

import { forwardRef, type CSSProperties, type InputHTMLAttributes, type ReactNode } from 'react';
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
 *
 * ## The two variants, and why they are variants
 *
 * `trackSlot` replaces the painted rail with one the caller draws, in the same
 * absolutely-positioned layer and reading the same `--slider-ratio` the fill
 * reads. `layout="block"` moves the readout above a full-width control instead
 * of beside it. Together they are the chatbot's confidence band (TAR-813): a
 * rail that says what the threshold *does* rather than how far along it sits.
 *
 * Variants rather than a second component, because the interactive element has
 * to stay the one native range this system already ships. A caller can repaint
 * the rail; it can never replace the thing that moves along it, so the keyboard
 * model, the touch drag and the `aria-valuetext` sentence are the same on both.
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
  /**
   * A replacement for the painted rail, drawn behind the knob in the same layer
   * and inheriting `--slider-ratio` (0–1) so it can line up against the knob.
   *
   * At most `--size-control-md` tall: the control's box is one
   * `--size-touch-target` row, and a taller rail would spill out of it.
   */
  trackSlot?: ReactNode;
  /** Where the readout sits: `inline` beside the control, `block` above it. */
  layout?: SliderLayout;
}

export const SLIDER_LAYOUTS = ['inline', 'block'] as const;
export type SliderLayout = (typeof SLIDER_LAYOUTS)[number];

export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  {
    value,
    min,
    max,
    step,
    onChange,
    valueLabel,
    id,
    className,
    trackSlot,
    layout = 'inline',
    ...rest
  },
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
    <div className={cx(styles.slider, className)} data-layout={layout}>
      {/* One element for the readout whichever layout is asked for — a screen
          reader hears the value in the same place, and only the stylesheet
          decides whether it sits above the control or after it.

          Not a live region: the input announces its own `aria-valuetext` on
          every change, and a polite region would say the same thing twice. */}
      <output className={styles.value} htmlFor={id}>
        {valueLabel}
      </output>
      <span className={styles.control}>
        <span
          aria-hidden="true"
          className={cx(styles.rail, trackSlot === undefined && styles.track)}
          style={{ '--slider-ratio': ratio } as CSSProperties}
        >
          {trackSlot ?? <span className={styles.fill} />}
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
    </div>
  );
});
