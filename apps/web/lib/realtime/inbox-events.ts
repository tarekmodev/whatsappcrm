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
 *
 * The two canned-response events are here because the composer's shortcut
 * library *is* part of this route's server render (TAR-486) — see the effect
 * table below.
 */
export const INBOX_SERVER_EVENTS = [
  'message.created',
  'message.status_changed',
  'conversation.updated',
  'note.created',
  'session.revoked',
  'canned_response.saved',
  'canned_response.deleted',
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
    // An admin edited the tenant's canned-response library. TAR-485 left these
    // two on `ignore` and handed the question here, on the reading that a
    // library edit "changes neither a thread nor a message" — true, and not the
    // test. `refetch` re-renders the inbox route, and the composer's copy of the
    // library is a *prop of that render*: `ThreadSection` reads the set on the
    // server and hands it to `MessageComposer`, which passes it down to the
    // picker unmemoised. So the same refresh that carries a new message also
    // carries the new shortcut text, and an agent gets the admin's edit without
    // touching anything (TAR-486).
    //
    // Refetch rather than applying `cannedResponse` from the payload, for this
    // file's standing reason: the server render re-runs the read rule, so an
    // agent who has lost `canned_response:read` between the two renders sees the
    // library disappear rather than keep a patched copy of it. The events are
    // rare — an admin saving a row, not a customer typing — so the route render
    // they cost is not a budget worth protecting with a second code path.
    case 'canned_response.saved':
    case 'canned_response.deleted':
      return 'refetch';
    // `sla.breached` and `ticket.escalated` are both addressed to a supervisor's
    // own user room and belong to the alert surfaces, not to the inbox — and an
    // escalation moves nothing on the ticket, so there is nothing on this screen
    // to re-render either. Listed rather than defaulted, like the ones beside
    // them, so this switch stays exhaustive: the day a wire event is added and
    // this screen should react to it, the compiler is what says so.
    case 'agent.typing':
    case 'ticket.updated':
    case 'sla.breached':
    case 'ticket.escalated':
      return 'ignore';
  }
}
