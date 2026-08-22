'use client';

import { useRouter } from 'next/navigation';
import { REPORT_RANGE_MAX_DAYS } from '@whatsappcrm/contracts';
import type { DateRange, DateRangePreset } from '@/components/ui/date-range';
import { DateRangeField } from '@/components/ui/DateRangeField';
import { FilterBar } from '@/components/ui/FilterBar';
import { FilterPills, type FilterPillItem } from '@/components/ui/FilterPills';
import { useContent, type Content } from '@/lib/content';
import { routes } from '@/lib/routes';
import { RANGE_PRESET_DAYS } from '@/features/reports/constants';
import { isUsableRange, presetRange, type ReportParams } from '@/features/reports/report-params';

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
 * Two groups on one baseline, which is what 0001's filter row asks for (TAR-516).
 * It used to be three: the quick ranges were their own pill strip beside two
 * native `<input type="date">` and an Apply button, and the scope was a third.
 * The quick ranges are now presets inside `DateRangeField`'s popover, where they
 * are the same filter as the dates rather than a group competing with them.
 *
 * Scope stays a strip of links, so a supervisor's "just my own" view is something
 * they can send somebody.
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

  return (
    <FilterBar label={content.reports.filtersLabel}>
      <DateRangeField
        label={content.reports.rangeHeading}
        value={{ from: params.from, to: params.to }}
        presets={presets(today, content)}
        max={today}
        validate={(range) => rangeError(range, content)}
        onChange={(range) => {
          router.push(routes.reports({ ...range, scope: params.scope }), { scroll: false });
        }}
      />

      <FilterPills label={content.reports.scopeFilterLabel} items={scopeItems(params, content)} />
    </FilterBar>
  );
}

/**
 * The same two rules `report-params.ts` narrows the URL by, phrased for a person.
 *
 * Shared with that module through `isUsableRange`, so the message the picker
 * shows and the range the URL parser accepts can never disagree — a form that
 * let through what the parser would silently rewrite is a form that appears to
 * do nothing.
 */
function rangeError(range: DateRange, content: Content): string | undefined {
  if (range.from > range.to) {
    return content.reports.rangeOrderError;
  }

  if (!isUsableRange(range.from, range.to)) {
    return content.reports.rangeTooLongError(REPORT_RANGE_MAX_DAYS);
  }

  return undefined;
}

function presets(today: string, content: Content): DateRangePreset[] {
  const labels: Record<number, string> = {
    7: content.reports.presetLast7,
    30: content.reports.presetLast30,
    90: content.reports.presetLast90,
  };

  return RANGE_PRESET_DAYS.map((days) => ({
    id: `preset-${String(days)}`,
    label: labels[days] ?? String(days),
    range: presetRange(today, days),
  }));
}

/**
 * Two pills rather than a select, so the scope stays a link.
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
