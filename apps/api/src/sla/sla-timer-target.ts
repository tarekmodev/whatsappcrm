import { TICKET_STATUS_PAUSES_SLA, type SlaTargetKind } from '@whatsappcrm/contracts';
import type { TicketStatus } from '../generated/prisma/enums';

/**
 * What state a timer *should* be in, given the ticket as it stands right now.
 *
 * A pure function, and the reason the evaluate handler can be a reconciler: it
 * answers from the ticket row alone, never from the trigger that woke it, so a
 * job that is lost, duplicated or delivered out of order converges on the same
 * answer. 0006's lifecycle diagram, as code.
 *
 * `breached` is deliberately not a target. A breach is something the sweep
 * observes about the clock, never something a ticket's state implies — and it is
 * terminal, so this function is not consulted about a timer that has one.
 * A ticket answered after it breached still stamps `first_response_at` and stops
 * accruing, but the timer stays `breached`: the supervisor's record of the miss
 * is not erased by a late reply.
 */
export type SlaTimerTarget = 'running' | 'paused' | 'met' | 'cancelled';

export interface SlaTimerTargetInput {
  readonly kind: SlaTargetKind;
  readonly status: TicketStatus;
  /** When a person first replied, or null. Written by the evaluate handler. */
  readonly firstRespondedAt: Date | null;
  readonly resolvedAt: Date | null;
}

export function slaTimerTargetFor({
  kind,
  status,
  firstRespondedAt,
  resolvedAt,
}: SlaTimerTargetInput): SlaTimerTarget {
  const achieved = kind === 'first_response' ? firstRespondedAt !== null : resolvedAt !== null;

  if (achieved) {
    return 'met';
  }

  // A ticket that reached a terminal status without hitting this target never
  // will: closing an unanswered ticket is not a breach, it is a clock with
  // nothing left to measure. `resolved` is here as well as `closed` because a
  // ticket resolved with no agent reply on it — a duplicate, a spam thread — is
  // the same situation, and leaving its first-response timer running would have
  // the sweep alert a supervisor about a ticket that is already done.
  if (status === 'resolved' || status === 'closed') {
    return 'cancelled';
  }

  // `pending` is the only status left that pauses: waiting on the customer is
  // time the agent cannot act on, and billing them for it would make the
  // deadline meaningless. Read from the contract's own table rather than
  // re-stated, so the two cannot drift.
  return TICKET_STATUS_PAUSES_SLA[status] ? 'paused' : 'running';
}
