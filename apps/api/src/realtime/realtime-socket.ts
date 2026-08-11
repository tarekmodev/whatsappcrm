import type { SessionPrincipal } from '@whatsappcrm/contracts';
import type { Socket } from 'socket.io';

/**
 * What the gateway knows about one connected socket, attached by the handshake
 * middleware before any event can be delivered.
 *
 * On `socket.data` rather than in a `Map` keyed by socket id: Socket.IO already
 * owns the lifetime of this object and drops it with the connection, whereas a
 * side map is a leak waiting for the one disconnect path that forgets to clean
 * up.
 */
export interface RealtimeSocketData {
  readonly principal: SessionPrincipal;
  /**
   * Correlation id for the connection, minted at handshake and reused by every
   * log line the socket produces — the socket-side equivalent of the per-request
   * id `TenantContextMiddleware` opens.
   */
  readonly requestId: string;
}

/** A socket that has been through the handshake middleware. */
export type RealtimeSocket = Socket<
  Record<string, (...args: never[]) => void>,
  Record<string, (...args: never[]) => void>,
  Record<string, (...args: never[]) => void>,
  RealtimeSocketData
>;

/**
 * The principal on an authenticated socket, or `null` on one that somehow
 * reached a handler without going through the handshake.
 *
 * `null` is not expected — the middleware runs before `connection` is fired, so
 * an event cannot arrive first — but a handler that read `socket.data.principal`
 * directly would be authorising on `undefined` if that ever stopped being true.
 * Every handler goes through here and refuses, which is the fail-closed shape.
 */
export function principalOf(socket: RealtimeSocket): SessionPrincipal | null {
  return socket.data.principal ?? null;
}
