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
 * Ticking or clearing "use the workspace default".
 *
 * Ticking rewrites the number too, so the field a supervisor is reading under a
 * ticked box shows the limit that would actually apply rather than the override
 * they are about to discard. Clearing leaves that number in place as the
 * starting point for an edit — the alternative is blanking a field somebody just
 * looked at.
 *
 * A function here rather than a spread at the call site because it is one half
 * of an invariant with {@link withLimit}: the checkbox and the number are never
 * both authoritative (TAR-778).
 */
export function withUsesDefault(
  draft: TicketLimitDraft,
  usesDefault: boolean,
  workspaceDefault: number,
): TicketLimitDraft {
  return usesDefault
    ? { usesDefault: true, limit: String(workspaceDefault) }
    : { usesDefault: false, limit: draft.limit };
}

/**
 * Typing a limit, which is also how the checkbox comes off.
 *
 * The field is disabled while the box is ticked, so in the browser this can only
 * arrive unticked — the clause is the invariant stated once rather than a case
 * anybody has to reach. Without it, a caller could construct a draft that both
 * inherits and overrides, and `resolveTicketLimit` would silently prefer one.
 */
export function withLimit(limit: string): TicketLimitDraft {
  return { usesDefault: false, limit };
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

/**
 * The limit this draft would actually put in force, or `null` while there is not
 * a usable one to speak of.
 *
 * Distinct from {@link resolveTicketLimit}, which answers *what to send*: there,
 * `null` means "clear the override" and is a perfectly good thing to send. Here
 * the question is what number rotation would then compare against, so a cleared
 * override resolves to the workspace default instead.
 *
 * One rule, so the below-load warning fires on the same condition whichever way
 * the supervisor arrived at it — typing 4 under a load of 6, or ticking a
 * workspace default of 5 under the same load. Two code paths for that would mean
 * one of them eventually stops warning (TAR-778).
 */
export function effectiveTicketLimit(
  draft: TicketLimitDraft,
  workspaceDefault: number,
): number | null {
  const resolved = resolveTicketLimit(draft);

  if (resolved.status === 'invalid') {
    return null;
  }

  return resolved.maxConcurrentTickets ?? workspaceDefault;
}
