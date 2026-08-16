import type { TicketEvent, TicketEventAssignment } from '@whatsappcrm/contracts';
import { content } from '@/content/en';
import type { BadgeTone } from '@/components/ui/Badge';

/**
 * Turns a `TicketEvent` into the three lines the history renders, per the
 * per-type encoding table in `TicketEventSchema` (ADR 0011 decision 4).
 *
 * Pure, and separate from the components, for the reason `presentation.ts`
 * already gives: the mapping is the part worth testing, and a renderer that
 * decided what an event *means* would put twelve branches inside JSX.
 *
 * The map below is a `Record<TicketEventType, …>`, so adding an event type to
 * the contract fails this file's build rather than rendering as a blank row.
 */

export interface TicketHistoryEntry {
  readonly id: string;
  /** ISO 8601, rendered relative on the client. */
  readonly createdAt: string;
  /** What happened, in one line. */
  readonly title: string;
  /** The movement behind it — from/to names, or a value change. Null when there is none. */
  readonly detail: string | null;
  /** Agent-supplied free text. Null on every event nobody wrote a reason for. */
  readonly reason: string | null;
  /** Who did it, already resolved to a name. Never blank — automation is named too. */
  readonly actorLabel: string;
  readonly tone: BadgeTone;
}

/** Resolved display names, from `loadDirectory`. */
export interface HistoryNames {
  readonly userNames: ReadonlyMap<string, string>;
  readonly teamNames: ReadonlyMap<string, string>;
}

export function toHistoryEntries(
  events: readonly TicketEvent[],
  names: HistoryNames,
): readonly TicketHistoryEntry[] {
  return events.map((event) => toHistoryEntry(event, names));
}

export function toHistoryEntry(event: TicketEvent, names: HistoryNames): TicketHistoryEntry {
  return {
    id: event.id,
    createdAt: event.createdAt,
    title: content.tickets.historyEvents[event.type],
    detail: detailFor(event, names),
    reason: event.reason,
    actorLabel: actorLabelFor(event, names),
    tone: EVENT_TONES[event.type],
  };
}

/**
 * The badge beside each entry.
 *
 * Only the two entries that mean *something needs attention* are drawn in a
 * warning or danger tone — an escalation and a missed SLA. Handoffs are ordinary
 * traffic and a log where every row shouts has highlighted nothing. Colour never
 * carries the meaning on its own: the title says it in words.
 */
const EVENT_TONES: Record<TicketEvent['type'], BadgeTone> = {
  created: 'neutral',
  conversation_linked: 'neutral',
  status_changed: 'info',
  priority_changed: 'info',
  assigned: 'info',
  unassigned: 'neutral',
  escalated: 'warning',
  assignment_deferred: 'warning',
  first_response: 'success',
  sla_breached: 'danger',
  reopened: 'info',
  bot_handoff: 'neutral',
};

/**
 * The second line: what moved.
 *
 * Three shapes, and which one applies is the event's type rather than which
 * fields happen to be populated — reading it off the data would make an
 * `escalated` event with a stray `assignment` render as a handoff.
 */
function detailFor(event: TicketEvent, names: HistoryNames): string | null {
  if (event.type === 'assigned' || event.type === 'unassigned') {
    return assignmentDetail(event.assignment, names);
  }

  if (event.type === 'escalated') {
    // Null `toValue` is meaningful: the escalation was addressed to whoever
    // supervises this ticket rather than to a person.
    return event.toValue === null
      ? content.tickets.historyEscalatedToAnyone
      : content.tickets.historyEscalatedTo(userLabel(event.toValue, names));
  }

  if (event.fromValue !== null && event.toValue !== null) {
    return content.tickets.historyValueChange(
      valueLabel(event.fromValue),
      valueLabel(event.toValue),
    );
  }

  return event.toValue === null ? null : valueLabel(event.toValue);
}

/**
 * "from Liang Wei to Amina Haddad", or just the destination when nobody held it.
 *
 * The from-half is omitted rather than written as "from nobody": a placement is
 * not a handoff, and saying it had a previous holder when it did not is the one
 * thing an audit line must not do.
 */
function assignmentDetail(
  assignment: TicketEventAssignment | null,
  names: HistoryNames,
): string | null {
  if (assignment === null) {
    return null;
  }

  const from = holderLabel(assignment.fromUserId, assignment.fromTeamId, names);
  const to = holderLabel(assignment.toUserId, assignment.toTeamId, names);

  if (to === null) {
    return from === null
      ? null
      : content.tickets.historyHandedFromTo(from, content.common.unassigned);
  }

  return from === null
    ? content.tickets.historyHandedTo(to)
    : content.tickets.historyHandedFromTo(from, to);
}

/**
 * A person if there is one, else the team, else nobody — the same order
 * `assigneeLabelFor` uses, so a row in the history and the header above it
 * cannot describe the same assignment differently.
 */
function holderLabel(
  userId: string | null,
  teamId: string | null,
  names: HistoryNames,
): string | null {
  if (userId !== null) {
    return userLabel(userId, names);
  }

  if (teamId !== null) {
    const teamName = names.teamNames.get(teamId);

    return teamName === undefined ? null : content.inbox.assignedToTeam(teamName);
  }

  return null;
}

/**
 * A name this reader's page of the directory could not resolve reports "another
 * agent" rather than the raw id. An id in an audit line is noise to the person
 * reading it and an identifier leak to everyone else.
 */
function userLabel(userId: string, names: HistoryNames): string {
  return names.userNames.get(userId) ?? content.tickets.historyActorUnresolved;
}

/**
 * `fromValue`/`toValue` carry a status, a priority, an SLA target kind or a
 * deferral reason depending on the event. They are looked up in the vocabularies
 * the rest of the console already renders, and fall through to the raw token —
 * which only happens for a value this console has no word for yet, and is more
 * honest than hiding it.
 */
function valueLabel(value: string): string {
  return (
    STATUS_LABELS[value] ??
    PRIORITY_LABELS[value] ??
    SLA_KIND_LABELS[value] ??
    DEFERRED_REASON_LABELS[value] ??
    value
  );
}

const STATUS_LABELS: Record<string, string | undefined> = content.ticketStatuses;
const PRIORITY_LABELS: Record<string, string | undefined> = content.ticketPriorities;
const SLA_KIND_LABELS: Record<string, string | undefined> = content.sla.kinds;
const DEFERRED_REASON_LABELS: Record<string, string | undefined> =
  content.assignment.deferredReasons;

/**
 * Who did it.
 *
 * `actorUserId` is null when the writer was routing, the SLA sweep or the
 * auto-linker, and that is named rather than left blank: "by the system" is a
 * fact an auditor needs, and an empty byline reads as missing data.
 */
function actorLabelFor(event: TicketEvent, names: HistoryNames): string {
  if (event.actorUserId === null) {
    return content.tickets.historyByAutomation;
  }

  return content.tickets.historyBy(userLabel(event.actorUserId, names));
}
