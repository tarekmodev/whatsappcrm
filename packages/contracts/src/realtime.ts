import { z } from 'zod';
import { CannedResponseResponseSchema } from './canned-responses';
import { IdSchema, TimestampSchema } from './common';
import { ConversationResponseSchema } from './conversations';
import { MessageResponseSchema } from './messages';
import { SlaAlertResponseSchema } from './sla';
import { TicketResponseSchema } from './tickets';

/**
 * The realtime contract — Socket.IO, per TAR-38's ADR.
 *
 * Rooms are the isolation boundary. A socket joins its rooms at connection time
 * from the *server's* view of the session — never from a room name the client
 * asked for. Client-supplied room names are the obvious way to leak another
 * tenant's inbox, so `join` only ever accepts a conversation id, which the
 * server then authorises before joining.
 *
 * ## Amendment (TAR-69 review): the tenant room is not the message audience
 *
 * As first published, every message event went to `tenant:{tenantId}` — every
 * socket in the tenant. That is wider than the REST surface for the same
 * principal: `isVisibleOrUnclaimed` refuses an agent a conversation somebody
 * else has claimed, and `GET /conversations/{id}` answers `not_found` for it,
 * while the socket was handing them its body and its attachment URLs. A room
 * fan-out that does not match the read rule is an authorization bypass, and the
 * fact that it was the published shape made it a spec defect rather than an
 * implementation slip.
 *
 * The rooms below are therefore the **audience of `isVisibleOrUnclaimed`, one
 * room per branch of it**:
 *
 * ```
 *   holds conversation:read_all  → tenantReadersRoom(tenantId)
 *   assigned to me               → userRoom(assignedUserId)
 *   assigned to a team I am in   → teamRoom(assignedTeamId)
 *   unclaimed                    → tenantRoom(tenantId)   ← every agent, correctly
 * ```
 *
 * A publisher addresses the branches that match the record's *current*
 * assignment; Socket.IO de-duplicates a socket that is in more than one. Because
 * the set is computed per emit rather than joined once, a thread that changes
 * hands changes audience on the very next event, with no stale membership to
 * clean up.
 *
 * `tenantRoom` keeps its meaning — every socket in the tenant — and keeps a job:
 * an unclaimed conversation genuinely is visible to everyone (0002, amendment
 * 4), because a customer wrote in and nobody has claimed it. It is simply no
 * longer the audience for a message on a thread that *has* been claimed.
 */

/**
 * Where the Socket.IO server sits on the API's own origin.
 *
 * Not Socket.IO's default `/socket.io`, and under `/realtime` rather than
 * `/api`: everything below `/api` is versioned by URI, and a transport endpoint
 * that is not a REST resource has no business inheriting a resource version. It
 * also keeps the WebSocket upgrade outside the prefix ADR 0002 decision 3 routes
 * through the Next.js rewrite — the socket connects to the `realtimeUrl` that
 * `POST /api/v1/auth/realtime-ticket` hands back, which is the whole reason the
 * handshake carries a ticket instead of a cookie.
 *
 * Published here rather than in the API because three places have to agree: the
 * gateway, the adapter that builds the server, and the console client that
 * connects to it — and the console cannot import from `apps/api`.
 */
export const REALTIME_PATH = '/realtime';

/** Every socket in the tenant. The audience for a conversation nobody has claimed. */
export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

/**
 * The sockets in this tenant whose principal holds `conversation:read_all` —
 * supervisors and admins, who may read every thread in the tenant.
 *
 * Nested under the tenant prefix rather than named `readers:{tenantId}` so that
 * every room name in this file starts with the scope it is confined to, which is
 * what makes an accidental cross-tenant room name obvious on sight.
 */
export function tenantReadersRoom(tenantId: string): string {
  return `tenant:${tenantId}:conversation-readers`;
}

/**
 * The sockets in this tenant whose principal holds `canned_response:read` — the
 * audience for an edit to the tenant's shared canned-response library (TAR-31,
 * 0011 decision 2).
 *
 * Every role holds that permission under today's `ROLE_PERMISSIONS`, so this is
 * the same set of sockets as `tenantRoom` — and it is still a separate room, on
 * `tenantReadersRoom`'s precedent and for its reason. The equality is a fact
 * about a constant TAR-22 may replace with tenant-configurable rows, while the
 * amendment above is a rule: a fan-out wider than the read rule is an
 * authorization bypass. Deriving the room from the permission is what stops that
 * from being discovered after it ships rather than before.
 *
 * Nested under the tenant prefix like every other room in this file, so a room
 * name confined to the wrong scope is obvious on sight.
 */
export function tenantCannedResponseRoom(tenantId: string): string {
  return `tenant:${tenantId}:canned-response-readers`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/**
 * The sockets whose principal is a member of this team, for a thread routed to
 * the team rather than to a person.
 *
 * A team id is globally unique, so this needs no tenant prefix to be unambiguous
 * — but the socket only ever joins teams named by its own resolved principal,
 * which is what confines it in practice.
 */
export function teamRoom(teamId: string): string {
  return `team:${teamId}`;
}

/**
 * What a conversation's audience is decided from: the tenant it belongs to and
 * who currently holds it.
 *
 * Structural rather than tied to a row type, for the same reason
 * `AssignableRecord` is on the server side — the two columns are the whole rule.
 */
export interface ConversationAudience {
  readonly tenantId: string;
  readonly assignedUserId: string | null;
  readonly assignedTeamId: string | null;
}

/**
 * Every room that may see an event about this conversation, and no other.
 *
 * This is `isVisibleOrUnclaimed` expressed as rooms, and it is published here so
 * the server that emits and the client that reasons about what it will receive
 * read the same rule rather than two descriptions of it. Branch for branch:
 *
 *   * `tenantReadersRoom` — always, because `conversation:read_all` sees
 *     everything in the tenant regardless of who holds the thread;
 *   * `userRoom` / `teamRoom` — whichever of the two assignments is set;
 *   * `tenantRoom` — **only** while the thread is unclaimed, which is the one
 *     case where every agent in the tenant is a legitimate audience.
 *
 * Deliberately does not include `conversationRoom`. A socket that subscribed to
 * a thread was authorised at that moment, and an authorisation from a moment ago
 * is not one now: a thread claimed since would keep publishing to whoever
 * happened to be watching it. Deriving the audience from the *current*
 * assignment on every emit is what makes the room set and the read rule agree by
 * construction rather than by remembering to clean up.
 */
export function conversationAudienceRooms(audience: ConversationAudience): string[] {
  const rooms = [tenantReadersRoom(audience.tenantId)];

  if (audience.assignedUserId !== null) {
    rooms.push(userRoom(audience.assignedUserId));
  }

  if (audience.assignedTeamId !== null) {
    rooms.push(teamRoom(audience.assignedTeamId));
  }

  if (audience.assignedUserId === null && audience.assignedTeamId === null) {
    rooms.push(tenantRoom(audience.tenantId));
  }

  return rooms;
}

/**
 * Server → client events. Every payload is a full resource rather than a delta:
 * the inbox is not worth a patch protocol, and a client that misses one event
 * while reconnecting would otherwise hold corrupt state forever.
 */
export const ServerEventSchema = z.discriminatedUnion('event', [
  z.object({
    event: z.literal('message.created'),
    conversationId: IdSchema,
    message: MessageResponseSchema,
  }),
  z.object({
    event: z.literal('message.status_changed'),
    conversationId: IdSchema,
    messageId: IdSchema,
    message: MessageResponseSchema,
  }),
  z.object({
    event: z.literal('conversation.updated'),
    conversation: ConversationResponseSchema,
  }),
  z.object({
    event: z.literal('ticket.updated'),
    ticket: TicketResponseSchema,
  }),
  z.object({
    event: z.literal('note.created'),
    conversationId: IdSchema,
    noteId: IdSchema,
    authorUserId: IdSchema,
  }),
  z.object({
    event: z.literal('agent.typing'),
    conversationId: IdSchema,
    userId: IdSchema,
    expiresAt: TimestampSchema,
  }),
  /**
   * A ticket missed its SLA deadline, sent to `user:{recipientUserId}` — once
   * per `sla_alerts` row the breach actually inserted, and to nobody else
   * (TAR-26, 0006 decision 5).
   *
   * Deliberately **not** `tenantReadersRoom`. The read rule for an alert is "you
   * are a named recipient", the rows say who that is, and the amendment above
   * rules that a fan-out wider than the read rule is an authorization bypass.
   *
   * The socket is the immediacy; the row is the record. A supervisor who was
   * offline when this fired sees the same alert on their next
   * `GET /api/v1/sla-alerts`, which is what makes "the supervisor is notified"
   * true rather than "a message was emitted".
   *
   * `ticket` rides along so the console can render the alert without a second
   * fetch, per this file's whole-resources rule. The ticket's own queue row also
   * moved, and that is published separately as `ticket.updated` to the
   * conversation audience — the two events have different audiences and neither
   * substitutes for the other.
   */
  z.object({
    event: z.literal('sla.breached'),
    alert: SlaAlertResponseSchema,
    ticket: TicketResponseSchema,
  }),
  /**
   * Sent to `user:{id}` when that user's session is revoked, so an open tab
   * logs out rather than sitting on a dead session until its next request.
   */
  z.object({
    event: z.literal('session.revoked'),
    sessionId: IdSchema,
  }),
  /**
   * A canned response was created or updated, published to
   * `tenantCannedResponseRoom` (TAR-31, 0011).
   *
   * **One event for both**, unlike the audit trail, which distinguishes them: an
   * auditor asks "who added this", while every consumer of this event performs
   * the same upsert. A discriminant nothing branches on is a discriminant that
   * drifts.
   *
   * The payload is the committed row, read back by the relay — a whole resource,
   * per this file's rule — so a console that prefers to patch its cache can,
   * without a contract change. The shipped console refetches instead
   * (`inbox-events.ts`), which is the console's call and not this contract's.
   */
  z.object({
    event: z.literal('canned_response.saved'),
    cannedResponse: CannedResponseResponseSchema,
  }),
  /**
   * A canned response is gone. The id alone, because there is no row left to
   * read back — the one place in this union where a whole resource is neither
   * available nor needed.
   */
  z.object({
    event: z.literal('canned_response.deleted'),
    cannedResponseId: IdSchema,
  }),
]);

export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventName = ServerEvent['event'];

/** Client → server events. Deliberately tiny: this is not a command channel. */
export const ClientEventSchema = z.discriminatedUnion('event', [
  z.object({ event: z.literal('conversation.subscribe'), conversationId: IdSchema }),
  z.object({ event: z.literal('conversation.unsubscribe'), conversationId: IdSchema }),
  z.object({ event: z.literal('typing'), conversationId: IdSchema }),
]);

export type ClientEvent = z.infer<typeof ClientEventSchema>;

/**
 * Handshake payload. The ticket comes from `POST /api/v1/auth/realtime-ticket`
 * and is single-use — see `auth.ts` for why a cookie cannot be used here.
 *
 * The verb was written here as `GET` until TAR-180 built the route. Both ADR
 * 0002 and ADR 0005 publish it as a `POST` and always have, and that is the one
 * that is right: each call mints and stores a new credential, which is not
 * something a safe method may do or an intermediary may replay.
 */
export const RealtimeHandshakeSchema = z.object({
  ticket: z.string().min(1),
});

export type RealtimeHandshake = z.infer<typeof RealtimeHandshakeSchema>;
