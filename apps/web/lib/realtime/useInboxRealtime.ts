'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { REALTIME_PATH } from '@whatsappcrm/contracts';
import type { Socket } from 'socket.io-client';
import { requestRealtimeTicket } from '@/lib/api/auth-browser';
import { isSessionExpiredError } from '@/lib/api/session-expiry';
import { INBOX_SERVER_EVENTS, inboxEffectOf } from '@/lib/realtime/inbox-events';
import { reconnectDelayMs } from '@/lib/realtime/reconnect-delay';

/**
 * Keeps the shared inbox current over TAR-69's Socket.IO gateway. Usage:
 * `useInboxRealtime({ isEnabled, conversationId })` from one headless client
 * component mounted on the inbox route.
 *
 * ## What it does with an event: nothing but refetch
 *
 * See `inbox-events.ts`. An event is a signal, never state — `router.refresh()`
 * re-renders the route on the server, which re-runs the same visibility rules
 * the API enforces. So a claim that changes who may see a thread cannot leave a
 * stale copy on screen, and a missed event is recovered by the next refetch
 * rather than by a replay the protocol does not offer.
 *
 * Refreshes are coalesced: a burst of six messages is one re-render, not six.
 *
 * ## Reconnection is ours, not Socket.IO's
 *
 * `reconnection: false` is deliberate. The handshake credential is a **single-
 * use** ticket that lives about a minute, so Socket.IO's built-in reconnect
 * would replay a spent ticket and be refused for ever — a socket that looks
 * like it is retrying while it can never succeed again. Each attempt therefore
 * mints a fresh ticket and builds a new socket, on the backoff in
 * `reconnect-delay.ts`.
 *
 * Every reconnect refetches before anything else, which is the whole of the
 * "no stale or missing messages after a dropped socket" guarantee.
 *
 * ## The chunk
 *
 * `socket.io-client` is imported dynamically, so it lands in its own chunk and
 * never enters the inbox route's initial JavaScript. It loads after paint, and
 * the inbox is fully usable — server-rendered, refreshable — while it does.
 */

export interface UseInboxRealtimeOptions {
  /**
   * `false` under the fixture transport, which has no socket server behind it.
   * Passed in rather than read here so the caller's server render decides it.
   */
  isEnabled: boolean;
  /** The open thread, subscribed to for its per-conversation events. */
  conversationId: string | null;
}

/** Long enough to coalesce a burst, short enough to read as live. */
const REFRESH_COALESCE_MS = 400;

export function useInboxRealtime({ isEnabled, conversationId }: UseInboxRealtimeOptions): void {
  const router = useRouter();
  const socketRef = useRef<Socket | null>(null);
  // A ref, not a dependency: the connection must survive changing threads, and
  // re-running the effect would tear down a healthy socket on every navigation.
  const conversationIdRef = useRef<string | null>(conversationId);

  useEffect(() => {
    if (!isEnabled) {
      return;
    }

    let isCancelled = false;
    let hasConnectedBefore = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let refreshTimer: ReturnType<typeof setTimeout> | null = null;

    const scheduleRefresh = (): void => {
      if (refreshTimer !== null) {
        return;
      }

      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        router.refresh();
      }, REFRESH_COALESCE_MS);
    };

    const scheduleReconnect = (): void => {
      if (isCancelled || reconnectTimer !== null) {
        return;
      }

      const delay = reconnectDelayMs(attempt);

      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void open();
      }, delay);
    };

    const teardownSocket = (): void => {
      const socket = socketRef.current;

      socketRef.current = null;

      if (socket !== null) {
        socket.removeAllListeners();
        socket.disconnect();
      }
    };

    const open = async (): Promise<void> => {
      try {
        // The ticket is fetched immediately before the connection because it
        // expires in about a minute; the import is concurrent with it rather
        // than before it, so the two waits overlap.
        const [{ io }, ticket] = await Promise.all([
          import('socket.io-client'),
          requestRealtimeTicket(),
        ]);

        if (isCancelled) {
          return;
        }

        const socket = io(ticket.realtimeUrl, {
          path: REALTIME_PATH,
          transports: ['websocket', 'polling'],
          auth: { ticket: ticket.ticket },
          reconnection: false,
        });

        socketRef.current = socket;

        socket.on('connect', () => {
          attempt = 0;
          subscribe(socket, conversationIdRef.current);

          if (hasConnectedBefore) {
            // Recovery after a drop. Not on the first connect: the markup on
            // screen is what the server rendered a moment ago.
            scheduleRefresh();
          }

          hasConnectedBefore = true;
        });

        for (const name of INBOX_SERVER_EVENTS) {
          socket.on(name, (payload: unknown) => {
            const effect = inboxEffectOf(payload);

            if (effect === 'refetch') {
              scheduleRefresh();
              return;
            }

            if (effect === 'signed-out') {
              // The server closes the socket straight after this. The refresh
              // is what hands the user to the route guard, which redirects to
              // sign-in carrying where they were — rather than leaving them on
              // a page they are no longer signed in to.
              isCancelled = true;
              teardownSocket();
              router.refresh();
            }
          });
        }

        socket.on('disconnect', () => {
          teardownSocket();
          scheduleReconnect();
        });

        socket.on('connect_error', () => {
          teardownSocket();
          scheduleReconnect();
        });
      } catch (error: unknown) {
        if (isSessionExpiredError(error)) {
          // The same rule the `session.revoked` branch states, applied to the
          // case that event cannot cover: a session revoked *while the socket
          // was down* is never announced, so the ticket request is the first
          // thing to learn of it. Retrying would be a 401 every thirty seconds
          // for ever, on an inbox that has silently stopped updating.
          isCancelled = true;
          teardownSocket();
          router.refresh();
          return;
        }

        // Never swallowed: a ticket the API refuses and a chunk that will not
        // load look identical on screen — a console that quietly stops updating.
        console.error('Realtime connection failed; retrying', error);
        scheduleReconnect();
      }
    };

    void open();

    return () => {
      isCancelled = true;

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
      }

      if (refreshTimer !== null) {
        clearTimeout(refreshTimer);
      }

      teardownSocket();
    };
  }, [isEnabled, router]);

  // Subscribing is what earns the per-conversation events (`note.created`,
  // `agent.typing`) whose audience genuinely is "whoever is looking at this
  // thread". The gateway authorises the id before it joins the room.
  useEffect(() => {
    const previous = conversationIdRef.current;

    conversationIdRef.current = conversationId;

    const socket = socketRef.current;

    if (socket === null || previous === conversationId) {
      return;
    }

    if (previous !== null) {
      socket.emit('conversation.unsubscribe', { conversationId: previous });
    }

    subscribe(socket, conversationId);
  }, [conversationId]);
}

function subscribe(socket: Socket, conversationId: string | null): void {
  if (conversationId !== null) {
    socket.emit('conversation.subscribe', { conversationId });
  }
}
