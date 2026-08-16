import { ServerEventSchema, type ServerEvent, type ServerEventName } from '@whatsappcrm/contracts';

/**
 * What the inbox does about a server event — the whole of the console's realtime
 * decision logic, kept apart from the socket so it can be tested without one.
 *
 * ## Refetch, never patch
 *
 * Every payload in `ServerEventSchema` is a full resource rather than a delta,
 * "because the inbox is not worth a patch protocol, and a client that misses one
 * event while reconnecting would otherwise hold corrupt state forever". The
 * console takes that at its word and goes one step further: it does not apply
 * the payload at all. An event is a *signal to refetch*, and the refetch is a
 * server render that re-runs the same visibility rules the API enforces.
 *
 * That is what makes a dropped socket recoverable. There is no replay to miss
 * and no merge to get wrong — reconnecting refetches, and the view is whatever
 * the server says it is.
 */

/**
 * The events the console subscribes to, by name.
 *
 * `agent.typing` and `ticket.updated` are deliberately absent: neither changes
 * what this screen renders, and subscribing to a typing indicator would refetch
 * the whole route on every keystroke somebody else makes.
 */
export const INBOX_SERVER_EVENTS = [
  'message.created',
  'message.status_changed',
  'conversation.updated',
  'note.created',
  'session.revoked',
] as const satisfies readonly ServerEventName[];

/**
 * What a socket payload means to this screen.
 *
 *   * `refetch` — something on screen is stale; re-render from the server.
 *   * `signed-out` — this session is gone; the route guard has to take over.
 *   * `ignore` — an event this screen does not render, or one that failed to
 *     parse. Malformed payloads are ignored rather than thrown: a socket frame
 *     is not a code path a user can retry, and a throw inside a listener takes
 *     the connection with it.
 */
export type InboxEffect = 'refetch' | 'signed-out' | 'ignore';

export function inboxEffectOf(payload: unknown): InboxEffect {
  const parsed = ServerEventSchema.safeParse(payload);

  return parsed.success ? effectOfEvent(parsed.data) : 'ignore';
}

function effectOfEvent(event: ServerEvent): InboxEffect {
  switch (event.event) {
    case 'session.revoked':
      return 'signed-out';
    case 'message.created':
    case 'message.status_changed':
    case 'conversation.updated':
    case 'note.created':
      return 'refetch';
    // `sla.breached` is addressed to a supervisor's own user room and belongs to
    // the alert surface TAR-281 builds, not to the inbox. Listed rather than
    // defaulted, like the two beside it, so this switch stays exhaustive: the
    // day a wire event is added and this screen should react to it, the compiler
    // is what says so.
    //
    // The two canned-response events are that compiler prompt arriving
    // (TAR-485). They are answered here rather than left to break the build, and
    // answered with `ignore` because nothing this table drives is stale after
    // one: `refetch` re-renders the *inbox route*, and an edit to the shared
    // library changes neither a thread nor a message. Which surface does react —
    // the composer's copy of the set, and the settings list — and whether it
    // reuses this hook at all is TAR-486's call, and its scope note says so.
    case 'agent.typing':
    case 'ticket.updated':
    case 'sla.breached':
    case 'canned_response.saved':
    case 'canned_response.deleted':
      return 'ignore';
  }
}
