'use client';

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { Icon } from './Icon';
import { useContent } from '@/lib/content';
import {
  addMonths,
  clampDate,
  isSameMonth,
  monthWeeks,
  shiftDays,
  startOfMonth,
} from '@/lib/date/calendar-date';
import {
  firstWeekdayFor,
  formatCalendarDateLong,
  formatCalendarMonth,
  weekdayHeadings,
} from '@/lib/format/calendar-date';
import styles from './DateRangeCalendar.module.css';

/**
 * One month of days, as a keyboard grid. Internal to `DateRangeField` — a
 * calendar with no field around it is not a control anyone should reach for.
 *
 * The **roving tabindex** is the whole accessibility model: the grid is one tab
 * stop, arrows move within it, and only the focused day is tabbable. Anything
 * else makes a month 31 tab stops between the field above and the button below.
 *
 * `focusedDate` is the caller's, not this component's, because it is also what
 * decides which month is on screen — the preset buttons and the two text fields
 * move the grid by moving it.
 */

export interface DateRangeCalendarProps {
  /** The drafted range's ends. Equal while a second date is still being picked. */
  from: string;
  to: string;
  /** The day the arrows are on, and whose month the grid shows. */
  focusedDate: string;
  onFocusedDateChange: (date: string) => void;
  onSelect: (date: string) => void;
  min?: string;
  max?: string;
}

const DAYS_PER_WEEK = 7;

export function DateRangeCalendar({
  from,
  to,
  focusedDate,
  onFocusedDateChange,
  onSelect,
  min,
  max,
}: DateRangeCalendarProps) {
  const content = useContent();
  const gridRef = useRef<HTMLDivElement>(null);
  // Only a keyboard move pulls focus with it. Re-focusing on every render would
  // steal the caret back from the text fields as they retype the grid.
  const shouldRestoreFocusRef = useRef(false);

  const monthStart = startOfMonth(focusedDate);
  const weeks = monthWeeks(monthStart, firstWeekdayFor(content.locale));
  const headings = weekdayHeadings(content.locale);
  const monthLabel = formatCalendarMonth(monthStart, content.locale);

  useEffect(() => {
    if (!shouldRestoreFocusRef.current) {
      return;
    }

    shouldRestoreFocusRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedDate}"]`)?.focus();
  }, [focusedDate]);

  function moveTo(date: string): void {
    shouldRestoreFocusRef.current = true;
    onFocusedDateChange(clampDate(date, min, max));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Under `dir="rtl"` the forward arrow is the left one. Read from the element
    // rather than from a prop, so a document-level direction is enough.
    const isRtl = getComputedStyle(event.currentTarget).direction === 'rtl';
    const forward = isRtl ? -1 : 1;

    const moves: Record<string, () => string> = {
      ArrowLeft: () => shiftDays(focusedDate, -forward),
      ArrowRight: () => shiftDays(focusedDate, forward),
      ArrowUp: () => shiftDays(focusedDate, -DAYS_PER_WEEK),
      ArrowDown: () => shiftDays(focusedDate, DAYS_PER_WEEK),
      Home: () => weekStart(focusedDate, firstWeekdayFor(content.locale)),
      End: () => shiftDays(weekStart(focusedDate, firstWeekdayFor(content.locale)), 6),
      PageUp: () => addMonths(focusedDate, -1),
      PageDown: () => addMonths(focusedDate, 1),
    };

    const move = moves[event.key];

    if (move === undefined) {
      return;
    }

    event.preventDefault();
    moveTo(move());
  }

  return (
    <div className={styles.calendar}>
      <div className={styles.header}>
        <button
          type="button"
          className={styles.step}
          aria-label={content.dateRange.previousMonth}
          disabled={min !== undefined && addMonths(monthStart, -1) < startOfMonth(min)}
          onClick={() => {
            moveTo(addMonths(focusedDate, -1));
          }}
        >
          <Icon name="chevronBack" size="sm" />
        </button>
        {/* Live, because paging the month changes what the grid below means and
            nothing else announces it. */}
        <p className={styles.monthLabel} aria-live="polite">
          {monthLabel}
        </p>
        <button
          type="button"
          className={styles.step}
          aria-label={content.dateRange.nextMonth}
          disabled={max !== undefined && addMonths(monthStart, 1) > max}
          onClick={() => {
            moveTo(addMonths(focusedDate, 1));
          }}
        >
          <Icon name="chevronForward" size="sm" />
        </button>
      </div>

      <div
        ref={gridRef}
        role="grid"
        aria-label={content.dateRange.gridLabel(monthLabel)}
        className={styles.grid}
        onKeyDown={handleKeyDown}
      >
        <div role="row" className={styles.week}>
          {headings.map((heading) => (
            <span key={heading.long} role="columnheader" className={styles.heading}>
              <abbr title={heading.long}>{heading.short}</abbr>
            </span>
          ))}
        </div>

        {weeks.map((week) => (
          <div key={week.start} role="row" className={styles.week}>
            {week.days.map((date) => (
              <span key={date} role="gridcell" aria-selected={isWithin(date, from, to)}>
                <button
                  type="button"
                  data-date={date}
                  data-outside={isSameMonth(date, monthStart) ? undefined : 'true'}
                  data-in-range={isWithin(date, from, to) ? 'true' : undefined}
                  data-edge={edgeOf(date, from, to)}
                  className={styles.day}
                  // One tab stop for the whole month; the arrows do the rest.
                  tabIndex={date === focusedDate ? 0 : -1}
                  disabled={isOutOfBounds(date, min, max)}
                  aria-label={formatCalendarDateLong(date, content.locale)}
                  onClick={() => {
                    onFocusedDateChange(date);
                    onSelect(date);
                  }}
                >
                  {Number(date.slice('YYYY-MM-'.length))}
                </button>
              </span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function weekStart(date: string, firstWeekday: number): string {
  const offset =
    (new Date(`${date}T00:00:00.000Z`).getUTCDay() - firstWeekday + DAYS_PER_WEEK) % DAYS_PER_WEEK;

  return shiftDays(date, -offset);
}

function isWithin(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

function edgeOf(date: string, from: string, to: string): 'start' | 'end' | undefined {
  if (date === from) {
    return 'start';
  }

  return date === to ? 'end' : undefined;
}

function isOutOfBounds(date: string, min: string | undefined, max: string | undefined): boolean {
  return (min !== undefined && date < min) || (max !== undefined && date > max);
}
