import { isSlaBreached, type SlaState, type TicketSla } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { BadgeTone } from '@/components/ui/Badge';
import type { DataTableRowTone } from '@/components/ui/DataTable';

/**
 * Maps a ticket's SLA state onto what the queue and the ticket view render.
 *
 * Kept out of the components for the reason the ticket module's own
 * `presentation.ts` is: the queue row, the detail summary and the alert panel
 * must label a breach identically, and the mapping in ADR 0006 §8.3 belongs in
 * one place rather than in three switch statements.
 *
 * ## Nothing here reads the clock
 *
 * "How overdue" is deliberately absent. ADR 0006 fixes the API to publishing the
 * *deadline* and never a duration, because a duration is stale the moment it is
 * serialised — and a `Date.now()` in a render would make the server's HTML and
 * the client's differ, which is a hydration mismatch rather than a feature.
 * `RelativeTime` already owns that: it renders the absolute value on the server
 * and upgrades to "in 40 minutes" after mount.
 */

/**
 * Tone per state. `running` is `info` rather than `warning`: a timer that is
 * simply running is the normal case, and a queue where every row shouts has no
 * way left to say that one of them is actually late.
 *
 * There is no "due soon" tone, and there cannot be one without reading the clock
 * during render — see the note above. A supervisor who wants the late ones
 * filters on Overdue.
 */
export const SLA_STATE_TONES: Record<SlaState, BadgeTone> = {
  not_applicable: 'neutral',
  running: 'info',
  paused: 'neutral',
  met: 'success',
  breached: 'danger',
};

/** The states that have a deadline worth showing. `not_applicable` has none. */
export type ObservableSlaState = Exclude<SlaState, 'not_applicable'>;

export interface SlaIndicatorModel {
  readonly state: ObservableSlaState;
  readonly tone: BadgeTone;
  /** The badge's own text. Always carries the meaning — colour never does. */
  readonly label: string;
  /** ISO 8601, exactly as the contract transports it. Rendered relative. */
  readonly dueAt: string;
  /**
   * True only while the deadline is still moving, so a running countdown
   * re-phrases itself and a settled one does not keep a timer alive for nothing.
   */
  readonly isCounting: boolean;
  /** Screen-reader prefix, so the figure is never a bare relative time. */
  readonly deadlineLabel: string;
}

/**
 * The first-response timer, or `null` when there is nothing to show.
 *
 * `null` covers two cases that look the same on screen and are different
 * underneath: a tenant with no active SLA policy (`not_applicable`), and a state
 * the contract allows to carry no deadline. Neither is an error, and neither is
 * worth a badge — an empty cell says "no SLA here" more clearly than a pill that
 * says nothing.
 */
export function firstResponseIndicator(sla: TicketSla): SlaIndicatorModel | null {
  return indicatorFor(
    sla.firstResponseState,
    sla.firstResponseDueAt,
    content.sla.firstResponseDeadline,
  );
}

export function resolutionIndicator(sla: TicketSla): SlaIndicatorModel | null {
  return indicatorFor(sla.resolutionState, sla.resolutionDueAt, content.sla.resolutionDeadline);
}

/**
 * The tone a queue row is flagged with, or `undefined` for an unremarkable one.
 *
 * Reads the contract's own `isSlaBreached` rather than a second copy of the
 * predicate, so the flag on the row and the `breachedOnly` filter above it
 * cannot disagree.
 *
 * A row tone is decoration on top of the badge in the SLA column, never instead
 * of it: the badge is what carries the meaning in text, which is what keeps the
 * flag from being colour alone.
 */
export function ticketRowTone(sla: TicketSla): DataTableRowTone | undefined {
  return isSlaBreached(sla) ? 'danger' : undefined;
}

const STATE_LABELS: Record<ObservableSlaState, string> = {
  running: content.sla.stateRunning,
  paused: content.sla.statePaused,
  met: content.sla.stateMet,
  breached: content.sla.stateBreached,
};

function indicatorFor(
  state: SlaState,
  dueAt: string | null,
  deadlineLabel: string,
): SlaIndicatorModel | null {
  if (state === 'not_applicable' || dueAt === null) {
    return null;
  }

  return {
    state,
    tone: SLA_STATE_TONES[state],
    label: STATE_LABELS[state],
    dueAt,
    isCounting: state === 'running',
    deadlineLabel,
  };
}
