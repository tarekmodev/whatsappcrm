import type { Content } from '@/lib/content';

/**
 * A minute count as the largest whole unit it divides into: 240 reads "4 hours",
 * 90 reads "90 minutes", 2880 reads "2 days".
 *
 * `Intl.NumberFormat`'s unit style rather than hand-rolled arithmetic and an "s",
 * so pluralisation is the browser's problem and a second locale needs no code.
 * The locale comes from the content module rather than the runtime, for the
 * reason `file-size.ts` pins one: a formatter that follows the runtime's locale
 * renders one string on the server and another in the browser, which is a
 * hydration mismatch rather than a nicety.
 *
 * In `lib/` rather than in a feature because two surfaces phrase the same
 * number: a workflow's "unresolved for 4 hours" trigger, and the SLA response
 * window a supervisor sets in minutes and reads back in hours (TAR-390). One
 * copy is what stops "90 minutes" and "1.5 hours" appearing on two screens
 * describing the same setting.
 *
 * Deliberately **not** `features/reports`' `formatDuration`, which is a
 * different function wearing a similar name: that one takes *seconds* and
 * renders the compact "2h 14m" a metric tile wants. These are minutes and
 * long-form, which is what a sentence wants.
 */

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;

export function formatMinutes(minutes: number, content: Content): string {
  const [value, unit] =
    minutes % MINUTES_PER_DAY === 0
      ? ([minutes / MINUTES_PER_DAY, 'day'] as const)
      : minutes % MINUTES_PER_HOUR === 0
        ? ([minutes / MINUTES_PER_HOUR, 'hour'] as const)
        : ([minutes, 'minute'] as const);

  return new Intl.NumberFormat(content.locale, {
    style: 'unit',
    unit,
    unitDisplay: 'long',
  }).format(value);
}
