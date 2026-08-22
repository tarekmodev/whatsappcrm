'use client';

import { DateRangePanel } from './DateRangePanel';
import { Icon } from './Icon';
import { MenuButton } from './MenuButton';
import { useContent } from '@/lib/content';
import { formatCalendarDate } from '@/lib/format/calendar-date';
import type { DateRange, DateRangePreset } from './date-range';
import styles from './DateRangeField.module.css';

/**
 * A from/to range on one trigger. Usage:
 * `<DateRangeField label="Date range" value={range} onChange={apply} presets={presets} max={today} />`.
 *
 * Replaces the pair of `<input type="date">` the dashboard used to carry
 * (TAR-516). Those brought the browser's own calendar glyph and its own locale
 * — `18/07/2026`, under a subtitle that said "18 Jul 2026" — into a row of
 * otherwise designed controls. This renders the workspace's format on both.
 *
 * The **quick ranges live inside the popover** as presets rather than beside it
 * as a second strip of pills. They are the same filter said two ways, and
 * splitting them made the dashboard's filter row three unrelated groups.
 *
 * No visible label, by 0001's filter-row rule: the trigger's own value says what
 * it filters, so `label` is the accessible name and nothing is repeated above it.
 *
 * Keyboard-complete, because a native date input is: the trigger opens on Enter
 * or Space, the grid moves by arrows and by PageUp/PageDown, Escape closes and
 * returns focus to the trigger, and both dates can simply be typed. All of the
 * popover behaviour is `MenuButton`'s — there is one disclosure implementation in
 * this app and this is not a second one.
 *
 * `value` is the **applied** range and stays the caller's, which is what lets a
 * screen keep it in the URL: the panel drafts, and `onChange` fires once.
 */

export interface DateRangeFieldProps {
  /** Names the control for assistive technology: "Date range". */
  label: string;
  value: DateRange;
  onChange: (range: DateRange) => void;
  /** Quick ranges, offered at the top of the popover. */
  presets?: readonly DateRangePreset[];
  /** The earliest selectable day, inclusive. */
  min?: string;
  /** The latest selectable day, inclusive — a report's "today". */
  max?: string;
  /** The caller's rules — "no more than a year" — phrased for a person. */
  validate?: (range: DateRange) => string | undefined;
  className?: string;
}

export function DateRangeField({
  label,
  value,
  onChange,
  presets = [],
  min,
  max,
  validate,
  className,
}: DateRangeFieldProps) {
  const content = useContent();
  const from = formatCalendarDate(value.from, content.locale);
  const to = formatCalendarDate(value.to, content.locale);

  return (
    <MenuButton
      align="start"
      variant="control"
      className={className}
      triggerClassName={styles.trigger}
      panelClassName={styles.panel}
      label={
        <>
          <Icon name="calendar" size="sm" />
          <span className={styles.value}>{content.dateRange.displayValue(from, to)}</span>
          <Icon name="chevronDown" size="sm" />
        </>
      }
      // The visible text is a pair of dates and says nothing about what they are
      // for; the en dash between them is also not something a screen reader
      // reliably reads as "to".
      accessibleName={content.dateRange.triggerName(label, content.dateRange.spokenValue(from, to))}
    >
      {({ close }) => (
        <DateRangePanel
          value={value}
          presets={presets}
          min={min}
          max={max}
          validate={validate}
          onApply={(range) => {
            onChange(range);
            close();
          }}
          onCancel={close}
        />
      )}
    </MenuButton>
  );
}
