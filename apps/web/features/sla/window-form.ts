import { SLA_WINDOW_MAX_MINUTES, type SlaPolicyResponse } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import { formatMinutes } from '@/lib/format/duration';

/**
 * The response-window form's rules and its phrasing (TAR-390).
 *
 * Pure and free of React, for the reason `features/workflows/presentation.ts` is:
 * "what does this number actually mean" is the part of this screen most worth
 * testing, and it needs no DOM.
 *
 * The bounds are the contract's own — `SLA_WINDOW_MAX_MINUTES`, the same 43 200
 * the API validates against — so nobody is sent on a round trip to be told
 * thirty-one days is too long. This is convenience, never enforcement: the
 * server action re-parses against `SlaPolicyUpdateInputSchema` and the API
 * refuses it again behind that.
 */

/** One minute. Below the contract's floor there is no window, only a typo. */
export const SLA_WINDOW_MIN_MINUTES = 1;
export { SLA_WINDOW_MAX_MINUTES };

export interface WindowInput {
  /** As typed. Empty means "no deadline of this kind", which the contract spells `null`. */
  readonly firstResponse: string;
  readonly resolution: string;
}

export interface WindowErrors {
  firstResponse?: string;
  resolution?: string;
}

/**
 * The typed value as the contract wants it, or `undefined` when it is not a
 * number at all.
 *
 * Three outcomes rather than two, and the distinction matters: `null` is an
 * emptied field — a deliberate "no deadline" the API accepts — while `undefined`
 * is a value that failed to parse, which `validateWindows` turns into a message
 * instead of a request.
 */
export function parseWindow(value: string): number | null | undefined {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  // `Number` rather than `parseInt`, which reads "30abc" as 30 and would save a
  // window nobody typed.
  const parsed = Number(trimmed);

  return Number.isInteger(parsed) &&
    parsed >= SLA_WINDOW_MIN_MINUTES &&
    parsed <= SLA_WINDOW_MAX_MINUTES
    ? parsed
    : undefined;
}

export function validateWindows(input: WindowInput): WindowErrors {
  const errors: WindowErrors = {};
  const invalid = content.slaSettings.windowInvalidError(
    SLA_WINDOW_MIN_MINUTES,
    SLA_WINDOW_MAX_MINUTES,
  );

  if (parseWindow(input.firstResponse) === undefined) {
    errors.firstResponse = invalid;
  }

  if (parseWindow(input.resolution) === undefined) {
    errors.resolution = invalid;
  }

  return errors;
}

/** A window for a control's `value`: the figure, or empty for "no deadline". */
export function toWindowInput(minutes: number | null): string {
  return minutes === null ? '' : String(minutes);
}

/**
 * One window as a sentence — "1 hour", or the copy for no deadline at all.
 *
 * Read-only surfaces phrase the figure rather than repeating it: a supervisor
 * checking whether their workspace answers within the hour should not have to
 * divide 60 by 60 to find out.
 */
export function describeWindow(minutes: number | null): string {
  return minutes === null ? content.slaSettings.windowUnset : formatMinutes(minutes, content);
}

/** The two windows one per-priority override sets, as one line. */
export function describeOverrideWindows(policy: SlaPolicyResponse): string {
  return content.slaSettings.overrideWindows(
    describeWindow(policy.firstResponseMinutes),
    describeWindow(policy.resolutionMinutes),
  );
}
