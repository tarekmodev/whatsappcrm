'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { REPORT_RANGE_MAX_DAYS } from '@whatsappcrm/contracts';
import { Button } from '@/components/ui/Button';
import { Field } from '@/components/ui/Field';
import { FilterPills, type FilterPillItem } from '@/components/ui/FilterPills';
import { TextInput } from '@/components/ui/TextInput';
import { useContent, type Content } from '@/lib/content';
import { routes } from '@/lib/routes';
import { RANGE_PRESET_DAYS } from '@/features/reports/constants';
import { isUsableRange, presetRange, type ReportParams } from '@/features/reports/report-params';
import styles from './ReportRangeFilters.module.css';

/**
 * The control that drives the dashboard. Usage:
 * `<ReportRangeFilters params={query} today={today} />`.
 *
 * **The URL is the state.** Applying a range navigates; it does not set component
 * state that the sections below then read. That is what makes a refresh, a copied
 * link and the back button reproduce the same view — and it is the mechanism
 * TAR-431's export control depends on, because an export URL derived from the
 * same search params cannot describe a range different from the one on screen.
 *
 * Three parts, and the split is deliberate:
 *
 *   - **Quick ranges** are links, so they are server-rendered, ship no JavaScript
 *     of their own and can be shared straight from the address bar.
 *   - **The two dates** are a real `<form>` with native `type="date"` controls:
 *     the platform's own picker, keyboard-enterable, localised by the browser, and
 *     no date-picker dependency in the bundle.
 *   - **Scope** is links again, for the same reason as the quick ranges.
 *
 * The form validates the two rules the endpoint refuses on — `from` after `to`,
 * and a range over a year — before navigating, so the answer to a mistyped date is
 * an inline message rather than a round trip and an error card.
 */

export interface ReportRangeFiltersProps {
  /** The applied range, already narrowed from the URL. */
  params: ReportParams;
  /** The server's calendar day, so nothing here reads the clock during render. */
  today: string;
}

export function ReportRangeFilters({ params, today }: ReportRangeFiltersProps) {
  const content = useContent();
  const router = useRouter();

  // Drafts, only until Apply. The URL stays the source of truth, and the effect
  // below keeps the boxes in step when it changes from elsewhere — a quick range,
  // the back button, a shared link.
  const [draftFrom, setDraftFrom] = useState(params.from);
  const [draftTo, setDraftTo] = useState(params.to);
  const toRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraftFrom(params.from);
    setDraftTo(params.to);
  }, [params.from, params.to]);

  const error = rangeError(draftFrom, draftTo, content);

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();

    // Focused rather than disabled: a submit button that cannot be pressed
    // leaves the tab order and says nothing about why, while moving the caret to
    // the field carrying the message says both.
    if (error !== undefined) {
      toRef.current?.focus();
      return;
    }

    router.push(routes.reports({ from: draftFrom, to: draftTo, scope: params.scope }), {
      scroll: false,
    });
  }

  return (
    <div className={styles.bar}>
      <FilterPills
        isLabelVisible
        label={content.reports.rangePresetLabel}
        items={presetItems(params, today, content)}
      />

      <form className={styles.range} onSubmit={handleSubmit} noValidate>
        <div className={styles.dates}>
          <Field label={content.reports.rangeFromLabel}>
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                id={controlId}
                type="date"
                name="from"
                value={draftFrom}
                max={today}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                onChange={(event) => {
                  setDraftFrom(event.target.value);
                }}
              />
            )}
          </Field>
          <Field
            label={content.reports.rangeToLabel}
            // The message hangs off the second field because that is where the
            // caret is when a range goes backwards, and `Field` is what wires it
            // to the control through `aria-describedby`.
            error={error}
          >
            {({ controlId, describedBy, isInvalid }) => (
              <TextInput
                ref={toRef}
                id={controlId}
                type="date"
                name="to"
                value={draftTo}
                max={today}
                aria-describedby={describedBy}
                aria-invalid={isInvalid}
                onChange={(event) => {
                  setDraftTo(event.target.value);
                }}
              />
            )}
          </Field>
        </div>
        <Button type="submit" variant="primary">
          {content.reports.rangeApply}
        </Button>
      </form>

      <FilterPills
        isLabelVisible
        label={content.reports.scopeFilterLabel}
        items={scopeItems(params, content)}
      />
    </div>
  );
}

/**
 * The same two rules `report-params.ts` narrows the URL by, phrased for a person.
 *
 * Shared with that module through `isUsableRange`, so the button being disabled
 * and the URL parser rejecting a range can never disagree — a form that let
 * through what the parser would silently rewrite is a form that appears to do
 * nothing.
 */
function rangeError(from: string, to: string, content: Content): string | undefined {
  if (from === '' || to === '') {
    return content.reports.rangeInvalidError;
  }

  if (from > to) {
    return content.reports.rangeOrderError;
  }

  if (!isUsableRange(from, to)) {
    return content.reports.rangeTooLongError(REPORT_RANGE_MAX_DAYS);
  }

  return undefined;
}

function presetItems(params: ReportParams, today: string, content: Content): FilterPillItem[] {
  const labels: Record<number, string> = {
    7: content.reports.presetLast7,
    30: content.reports.presetLast30,
    90: content.reports.presetLast90,
  };

  return RANGE_PRESET_DAYS.map((days) => {
    const range = presetRange(today, days);

    return {
      id: `preset-${String(days)}`,
      label: labels[days] ?? String(days),
      href: routes.reports({ ...range, scope: params.scope }),
      // "Current" is the range matching, not the button that was pressed: a
      // hand-typed 30 days is the same view as the preset, and a pill that
      // refused to admit it would look like a filter that had not applied.
      isCurrent: params.from === range.from && params.to === range.to,
    };
  });
}

/**
 * Two pills rather than a select, so the scope stays a link and a supervisor's
 * "just my own" view is something they can send somebody.
 *
 * Both are offered to every role. The API narrows `all` for a caller without
 * `report:read_all` rather than refusing it, so hiding the pill would remove a
 * view that works — and the notice above the table says what was narrowed.
 */
function scopeItems(params: ReportParams, content: Content): FilterPillItem[] {
  return [
    {
      id: 'scope-all',
      label: content.reports.scopeAll,
      href: routes.reports({ from: params.from, to: params.to, scope: 'all' }),
      isCurrent: params.scope === 'all',
    },
    {
      id: 'scope-assigned',
      label: content.reports.scopeAssigned,
      href: routes.reports({ from: params.from, to: params.to, scope: 'assigned' }),
      isCurrent: params.scope === 'assigned',
    },
  ];
}
