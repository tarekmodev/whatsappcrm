'use client';

import { useEffect, useState } from 'react';
import { DateRangeCalendar } from './DateRangeCalendar';
import { Icon } from './Icon';
import { MenuButton } from './MenuButton';
import { TextInput } from './TextInput';
import { useContent } from '@/lib/content';
import { clampDate, isCalendarDate, toCalendarDate } from '@/lib/date/calendar-date';
import styles from './DateField.module.css';

/**
 * One calendar day, typed or picked. Usage:
 * `<DateField id={controlId} value={value} onChange={setValue} accessibleName="Renewal date" />`.
 *
 * `DateRangeField`'s single-date sibling, and the replacement for
 * `<input type="date">` in a form (TAR-516). A native date input paints the
 * browser's own calendar glyph and reads back the browser's own locale, so one
 * on a page of designed controls looks like a control from another product.
 *
 * The **text box is the control**: the value is a `YYYY-MM-DD` string, exactly
 * what the native input produced, and it keeps the label, the description and
 * the invalid state a `Field` wired to it. The calendar beside it is an
 * affordance, not a replacement — nobody has to open a popover to type a date.
 */

export interface DateFieldProps {
  /** From `Field`'s render prop, so the label points at the text box. */
  id: string;
  value: string;
  onChange: (value: string) => void;
  name?: string;
  disabled?: boolean;
  /** The earliest and latest selectable day, both inclusive. */
  min?: string;
  max?: string;
  /** Names the icon-only calendar trigger: the field's own label. */
  accessibleName: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
}

export function DateField({
  id,
  value,
  onChange,
  name,
  disabled = false,
  min,
  max,
  accessibleName,
  'aria-describedby': describedBy,
  'aria-invalid': isInvalid,
}: DateFieldProps) {
  const content = useContent();
  const [focusedDate, setFocusedDate] = useState(value);
  const [today, setToday] = useState<string | undefined>(undefined);

  useEffect(() => {
    // The clock, read after mount rather than during render: a `new Date()` in a
    // render makes the server's markup and the browser's differ. The popover
    // cannot be open before this runs, so nothing is ever drawn at the fallback.
    setToday(toCalendarDate(new Date()));
  }, []);

  // Where the grid opens when the box is empty or half-typed.
  const gridDate = clampDate(
    isCalendarDate(focusedDate) ? focusedDate : (today ?? max ?? min ?? EPOCH_DAY),
    min,
    max,
  );

  return (
    <div className={styles.group}>
      <TextInput
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        placeholder={content.dateRange.format}
        value={value}
        disabled={disabled}
        className={styles.input}
        aria-describedby={describedBy}
        aria-invalid={isInvalid}
        onChange={(event) => {
          onChange(event.target.value);
          setFocusedDate(event.target.value);
        }}
      />
      <MenuButton
        align="end"
        variant="control"
        triggerClassName={styles.trigger}
        panelClassName={styles.panel}
        label={<Icon name="calendar" size="sm" />}
        accessibleName={content.dateRange.openCalendar(accessibleName)}
      >
        {({ close }) => (
          <DateRangeCalendar
            // A single day is a range of one; the grid then needs no second mode
            // and no second set of range-highlighting rules.
            from={gridDate}
            to={gridDate}
            focusedDate={gridDate}
            onFocusedDateChange={setFocusedDate}
            onSelect={(date) => {
              onChange(date);
              close();
            }}
            min={min}
            max={max}
          />
        )}
      </MenuButton>
    </div>
  );
}

/**
 * Only reachable on the server render, where the popover is closed and nothing
 * draws it. A stable literal rather than the clock, for exactly that reason.
 */
const EPOCH_DAY = '2000-01-01';
