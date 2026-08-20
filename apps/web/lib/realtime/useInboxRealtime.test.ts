import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { RealtimeTicketResponse, ServerEvent } from '@whatsappcrm/contracts';
import { useInboxRealtime } from '@/lib/realtime/useInboxRealtime';

/**
 * The socket end of the console's realtime wiring, with the transport faked:
 * a frame arrives, and the route refetches or it does not.
 *
 * `inbox-events.test.ts` covers *which* frames mean refetch. This covers the two
 * things only the hook can answer — that it is listening for them at all, and
 * that everything it opened is closed again when the inbox unmounts (TAR-486).
 *
 * Cross-tenant events are not testable here and are not meant to be: the fan-out
 * is confined by the room a socket is joined to at the handshake, from the
 * principal the ticket resolved — `tenantCannedResponseRoom`, pinned by the API's
 * `realtime-isolation.int-spec.ts`. A client-side tenant check would be a second
 * opinion about something this process cannot know.
 */

interface FakeSocket {
  readonly handlers: Map<string, (payload: unknown) => void>;
  readonly emitted: { readonly event: string; readonly payload: unknown }[];
  isDisconnected: boolean;
  hasListeners: boolean;
  on: (event: string, handler: (payload: unknown) => void) => void;
  emit: (event: string, payload: unknown) => void;
  removeAllListeners: () => void;
  disconnect: () => void;
}

const transport = vi.hoisted(() => {
  const sockets: FakeSocket[] = [];

  return {
    sockets,
    io: (): FakeSocket => {
      const socket: FakeSocket = {
        handlers: new Map(),
        emitted: [],
        isDisconnected: false,
        hasListeners: false,
        on(event, handler) {
          socket.handlers.set(event, handler);
          socket.hasListeners = true;
        },
        emit(event, payload) {
          socket.emitted.push({ event, payload });
        },
        removeAllListeners() {
          socket.handlers.clear();
          socket.hasListeners = false;
        },
        disconnect() {
          socket.isDisconnected = true;
        },
      };

      sockets.push(socket);

      return socket;
    },
  };
});

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn(), push: vi.fn() }));
const auth = vi.hoisted(() => ({ requestRealtimeTicket: vi.fn() }));

vi.mock('next/navigation', () => ({ useRouter: () => router }));
vi.mock('@/lib/api/auth-browser', () => ({ requestRealtimeTicket: auth.requestRealtimeTicket }));
vi.mock('socket.io-client', () => ({ io: transport.io }));

const TICKET: RealtimeTicketResponse = {
  ticket: 'tkt_0192f00b',
  expiresAt: '2026-08-12T12:01:00.000Z',
  realtimeUrl: 'https://realtime.whatsappcrm.example',
};

/** Typed as the contract, so a fixture the gateway could never send fails here. */
const CANNED_RESPONSE_SAVED = {
  event: 'canned_response.saved',
  cannedResponse: {
    id: '0192f00c-0000-7000-8000-000000000c01',
    shortcut: '/hours',
    title: 'Opening hours',
    body: "We're open Sunday to Thursday, 9am to 6pm.",
    createdByUserId: null,
    createdAt: '2026-08-11T08:00:00.000Z',
    updatedAt: '2026-08-12T09:30:00.000Z',
  },
} satisfies ServerEvent;

/** Longer than the hook's own coalescing window, so a due refresh has fired. */
const PAST_COALESCE_MS = 500;

const CONVERSATION_ID = '0192f004-0000-7000-8000-000000000401';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  transport.sockets.length = 0;
  router.refresh.mockReset();
  auth.requestRealtimeTicket.mockReset();
  auth.requestRealtimeTicket.mockResolvedValue(TICKET);
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the hook and waits for the socket its first ticket buys. */
async function connect(): Promise<{ socket: FakeSocket; unmount: () => void }> {
  const view = renderHook(() =>
    useInboxRealtime({ isEnabled: true, conversationId: CONVERSATION_ID }),
  );

  await waitFor(() => {
    expect(transport.sockets).toHaveLength(1);
  });

  const socket = transport.sockets[0];

  if (socket === undefined) {
    throw new Error('The hook did not open a socket.');
  }

  act(() => {
    socket.handlers.get('connect')?.(undefined);
  });

  return { socket, unmount: view.unmount };
}

function deliver(socket: FakeSocket, payload: ServerEvent): void {
  const handler = socket.handlers.get(payload.event);

  expect(handler, `the hook does not listen for ${payload.event}`).toBeDefined();

  act(() => {
    handler?.(payload);
  });
}

describe('a canned-response edit', () => {
  it('refetches the route, so the composer picks the new text up', async () => {
    const { socket } = await connect();

    deliver(socket, CANNED_RESPONSE_SAVED);

    // The first connect does not refetch on its own, so a refresh here is this
    // event's and nothing else's.
    expect(router.refresh).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(PAST_COALESCE_MS);
    });

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('refetches on a deletion too, so a removed shortcut stops matching', async () => {
    const { socket } = await connect();

    deliver(socket, {
      event: 'canned_response.deleted',
      cannedResponseId: CANNED_RESPONSE_SAVED.cannedResponse.id,
    });

    act(() => {
      vi.advanceTimersByTime(PAST_COALESCE_MS);
    });

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('is one refetch when an admin saves several rows at once', async () => {
    const { socket } = await connect();

    deliver(socket, CANNED_RESPONSE_SAVED);
    deliver(socket, CANNED_RESPONSE_SAVED);
    deliver(socket, CANNED_RESPONSE_SAVED);

    act(() => {
      vi.advanceTimersByTime(PAST_COALESCE_MS);
    });

    expect(router.refresh).toHaveBeenCalledTimes(1);
  });
});

describe('leaving the inbox', () => {
  it('closes the socket and drops every listener', async () => {
    const { socket, unmount } = await connect();

    act(() => {
      unmount();
    });

    expect(socket.isDisconnected).toBe(true);
    expect(socket.hasListeners).toBe(false);
  });

  it('does not refetch a route that is gone', async () => {
    const { socket, unmount } = await connect();

    // The event lands while the coalescing timer is still pending — the window
    // in which an agent navigates away mid-burst.
    deliver(socket, CANNED_RESPONSE_SAVED);

    act(() => {
      unmount();
      vi.advanceTimersByTime(PAST_COALESCE_MS);
    });

    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('does not reconnect after unmount', async () => {
    const { socket, unmount } = await connect();
    const onDisconnect = socket.handlers.get('disconnect');

    act(() => {
      unmount();
    });

    act(() => {
      // A drop reported as the socket is torn down must not schedule a retry,
      // or the console leaks a connection per visit to the inbox.
      onDisconnect?.(undefined);
      vi.advanceTimersByTime(30_000);
    });

    expect(transport.sockets).toHaveLength(1);
  });
});

describe('the fixture transport', () => {
  it('opens no socket at all', () => {
    renderHook(() => useInboxRealtime({ isEnabled: false, conversationId: CONVERSATION_ID }));

    act(() => {
      vi.advanceTimersByTime(30_000);
    });

    expect(transport.sockets).toHaveLength(0);
    expect(auth.requestRealtimeTicket).not.toHaveBeenCalled();
  });
});
