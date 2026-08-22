'use client';

import { useRef, useState } from 'react';
import { Button } from './Button';
import { DateRangeCalendar } from './DateRangeCalendar';
import { Field } from './Field';
import { TextInput } from './TextInput';
import { useContent } from '@/lib/content';
import { isCalendarDate } from '@/lib/date/calendar-date';
import type { DateRange, DateRangePreset } from './date-range';
import styles from './DateRangePanel.module.css';

/**
 * What is inside `DateRangeField`'s popover: the presets, the two typed dates
 * and the calendar, over one draft.
 *
 * Mounted fresh on every open, which is what makes the draft correct without an
 * effect syncing it: `MenuButton` drops its panel from the DOM when closed, so
 * "reset to the applied range on open" is just `useState`'s initial value.
 *
 * A **draft**, not a live filter. The range is applied on Apply or on a preset,
 * never on the first of two clicks in the grid — a half-picked range would send
 * the dashboard off to fetch a single day nobody asked for.
 */

export interface DateRangePanelProps {
  value: DateRange;
  presets: readonly DateRangePreset[];
  min: string | undefined;
  max: string | undefined;
  /** The caller's rules, phrased for a person. `undefined` means applicable. */
  validate: ((range: DateRange) => string | undefined) | undefined;
  onApply: (range: DateRange) => void;
  onCancel: () => void;
}

export function DateRangePanel({
  value,
  presets,
  min,
  max,
  validate,
  onApply,
  onCancel,
}: DateRangePanelProps) {
  const content = useContent();
  const [draft, setDraft] = useState<DateRange>(value);
  const [focusedDate, setFocusedDate] = useState(draft.from);
  // Set by the first of the two clicks that make a range; null while the drafted
  // range is complete and the next click starts a new one.
  const [pendingStart, setPendingStart] = useState<string | null>(null);
  const toRef = useRef<HTMLInputElement>(null);

  const error = rangeError(draft, validate, content.dateRange.invalidDate);

  function editDate(end: keyof DateRange, next: string): void {
    setDraft((current) =>
      end === 'from' ? { from: next, to: current.to } : { from: current.from, to: next },
    );
    setPendingStart(null);

    // Typing a real date walks the grid to it, so the two halves of the control
    // never disagree about which month is being looked at.
    if (isCalendarDate(next)) {
      setFocusedDate(next);
    }
  }

  function selectDate(date: string): void {
    if (pendingStart === null) {
      setPendingStart(date);
      setDraft({ from: date, to: date });
      return;
    }

    setPendingStart(null);
    setDraft(
      date < pendingStart ? { from: date, to: pendingStart } : { from: pendingStart, to: date },
    );
  }

  return (
    <div className={styles.panel}>
      {presets.length > 0 ? (
        <ul className={styles.presets} aria-label={content.dateRange.presetsLabel}>
          {presets.map((preset) => (
            <li key={preset.id}>
              <button
                type="button"
                className={styles.preset}
                // A toggle, not a link: the pressed one is the range currently
                // applied, however it was arrived at — a hand-typed 30 days is
                // the same view as the preset and a pill that denied it would
                // read as a filter that had not taken.
                aria-pressed={preset.range.from === value.from && preset.range.to === value.to}
                onClick={() => {
                  onApply(preset.range);
                }}
              >
                {preset.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={styles.dates}>
        <Field label={content.dateRange.fromLabel}>
          {({ controlId }) => (
            <TextInput
              id={controlId}
              name="from"
              inputMode="numeric"
              autoComplete="off"
              placeholder={content.dateRange.format}
              value={draft.from}
              aria-invalid={error !== undefined}
              onChange={(event) => {
                editDate('from', event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label={content.dateRange.toLabel}
          // The message hangs off the second field because that is where the
          // caret is sent when a range goes backwards, and `Field` is what wires
          // it to the control through `aria-describedby`. Deliberately not a
          // `role="alert"`, which would re-announce on every keystroke of a date
          // that is not finished being typed yet.
          error={error}
        >
          {({ controlId, describedBy, isInvalid }) => (
            <TextInput
              ref={toRef}
              id={controlId}
              name="to"
              inputMode="numeric"
              autoComplete="off"
              placeholder={content.dateRange.format}
              value={draft.to}
              aria-describedby={describedBy}
              aria-invalid={isInvalid}
              onChange={(event) => {
                editDate('to', event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <hr className={styles.divider} />

      <DateRangeCalendar
        from={draft.from}
        to={draft.to}
        focusedDate={focusedDate}
        onFocusedDateChange={setFocusedDate}
        onSelect={selectDate}
        min={min}
        max={max}
      />

      <div className={styles.actions}>
        <Button size="sm" onClick={onCancel}>
          {content.common.cancel}
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            // Focused rather than disabled: a button that cannot be pressed
            // leaves the tab order and says nothing about why, while moving the
            // caret to the field carrying the message says both.
            if (error !== undefined) {
              toRef.current?.focus();
              return;
            }

            onApply(draft);
          }}
        >
          {content.dateRange.apply}
        </Button>
      </div>
    </div>
  );
}

function rangeError(
  draft: DateRange,
  validate: ((range: DateRange) => string | undefined) | undefined,
  invalidDate: string,
): string | undefined {
  if (!isCalendarDate(draft.from) || !isCalendarDate(draft.to)) {
    return invalidDate;
  }

  return validate?.(draft);
}
