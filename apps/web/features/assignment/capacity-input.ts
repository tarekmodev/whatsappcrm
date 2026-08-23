import { ASSIGNMENT_POLICY } from '@whatsappcrm/contracts';
import type { AgentCapacityRow } from './capacity';

/**
 * What the cap-edit form holds while it is being edited, and how that becomes
 * something the API will accept.
 *
 * Separated from the dialog so the rule that decides whether a typed value is a
 * limit can be tested without rendering a form, and so the dialog and its test
 * cannot disagree about where the bounds are.
 */

export interface TicketLimitDraft {
  /** True when this agent should inherit the workspace default instead. */
  usesDefault: boolean;
  /**
   * Exactly what was typed, as text.
   *
   * Not a number: a number field mid-edit is legitimately empty or a lone minus
   * sign, and coercing those to `0` or `NaN` would either save a value nobody
   * typed or wipe what they were typing.
   */
  limit: string;
}

/** The form's opening state for one agent: their own limit, or the inherited one. */
export function draftForRow(row: AgentCapacityRow): TicketLimitDraft {
  return {
    usesDefault: row.capacity.maxConcurrentTickets === null,
    limit: String(row.capacity.effectiveMaxConcurrentTickets),
  };
}

/**
 * What this draft would send, or that it would send nothing.
 *
 * A union rather than `number | null`, because `null` already means something
 * here — clear the override and inherit the workspace default — and a function
 * that used it for "this is not a number" would make the two indistinguishable at
 * every call site.
 *
 * The bounds come from `ASSIGNMENT_POLICY`, which is also what the CHECK
 * constraint and the contract schema are written from: this is a courtesy so a
 * supervisor is told before the round trip, never a second opinion about what is
 * allowed.
 */
export type TicketLimitResolution =
  { status: 'valid'; maxConcurrentTickets: number | null } | { status: 'invalid' };

export function resolveTicketLimit(draft: TicketLimitDraft): TicketLimitResolution {
  if (draft.usesDefault) {
    return { status: 'valid', maxConcurrentTickets: null };
  }

  const trimmed = draft.limit.trim();
  // `Number` rather than `parseInt`: `parseInt('3 tickets')` is 3, which would
  // send a number the supervisor never typed.
  const value = trimmed === '' ? Number.NaN : Number(trimmed);

  return Number.isInteger(value) &&
    value >= ASSIGNMENT_POLICY.minMaxConcurrentTickets &&
    value <= ASSIGNMENT_POLICY.maxMaxConcurrentTickets
    ? { status: 'valid', maxConcurrentTickets: value }
    : { status: 'invalid' };
}
