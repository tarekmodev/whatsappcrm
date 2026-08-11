import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common';
import { ConversationResponseSchema } from './conversations';
import { MessageResponseSchema } from './messages';
import { TicketResponseSchema } from './tickets';

/**
 * The realtime contract — Socket.IO, per TAR-38's ADR.
 *
 * Rooms are the isolation boundary. A socket joins `tenant:{tenantId}` exactly
 * once, at connection time, from the *server's* view of the session — never from
 * a room name the client asked for. Client-supplied room names are the obvious
 * way to leak another tenant's inbox, so `join` only ever accepts a conversation
 * id, which the server then authorises before joining.
 */

export function tenantRoom(tenantId: string): string {
  return `tenant:${tenantId}`;
}

export function conversationRoom(conversationId: string): string {
  return `conversation:${conversationId}`;
}

export function userRoom(userId: string): string {
  return `user:${userId}`;
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
   * Sent to `user:{id}` when that user's session is revoked, so an open tab
   * logs out rather than sitting on a dead session until its next request.
   */
  z.object({
    event: z.literal('session.revoked'),
    sessionId: IdSchema,
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
