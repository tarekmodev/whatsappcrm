import { permissionsForRole, userRoom, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { Server } from 'socket.io';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { SessionService } from '../identity/session.service';
import type { CannedResponseResourceService } from './canned-response-resource.service';
import type { ConversationResourceService } from './conversation-resource.service';
import type { EscalationResourceService } from './escalation-resource.service';
import type { MessageResourceService } from './message-resource.service';
import { RealtimeRelayService } from './realtime-relay.service';
import type { RealtimeSocketData } from './realtime-socket';
import type { SlaBreachResourceService } from './sla-breach-resource.service';
import type { TenantHostnameService } from './tenant-hostname.service';

/**
 * A revoked session reaching the socket that was opened with it (TAR-69 review,
 * Major 1).
 *
 * The gap: authentication happens once, at the handshake, and a WebSocket has no
 * next request to be refused on. Without this an agent an admin suspends keeps a
 * live socket until the tab closes — bounded only by the 30-day absolute session
 * cap — which contradicts what `SessionRevocationService` states it is for.
 *
 * What is asserted here is the shape that makes it *correct* rather than merely
 * present: each socket is judged on its own session rather than on the event, so
 * a signed-in password change (which spares one session) and a single-device
 * sign-out do not take down the tabs that survived.
 */

const TENANT = '80111111-1111-7111-8111-111111111101';
const USER = '80111111-1111-7111-8111-1111111111a1';
const LIVE_SESSION = '80111111-1111-7111-8111-1111111111f1';
const DEAD_SESSION = '80111111-1111-7111-8111-1111111111f2';

interface FakeSocket {
  readonly data: RealtimeSocketData | Record<string, never>;
  readonly emitted: { event: string; payload: unknown }[];
  disconnected: boolean;
  emit: (event: string, payload: unknown) => void;
  disconnect: (close: boolean) => void;
}

function socketFor(sessionId: string | null): FakeSocket {
  const emitted: { event: string; payload: unknown }[] = [];

  const socket: FakeSocket = {
    data: sessionId === null ? {} : { principal: principal(sessionId), requestId: 'req-1' },
    emitted,
    disconnected: false,
    emit: (event, payload) => {
      emitted.push({ event, payload });
    },
    disconnect: () => {
      socket.disconnected = true;
    },
  };

  return socket;
}

function principal(sessionId: string): SessionPrincipal {
  return {
    userId: USER,
    tenantId: TENANT,
    email: 'ada@acme.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId,
    expiresAt: '2036-12-31T23:59:59.000Z',
  };
}

interface Harness {
  readonly relay: RealtimeRelayService;
  readonly rooms: string[];
  /** The tenant in scope each time a session was re-read. */
  readonly scopes: (string | null)[];
}

function harnessFor(sockets: FakeSocket[], live: string[] = [LIVE_SESSION]): Harness {
  const rooms: string[] = [];
  const scopes: (string | null)[] = [];
  const tenantContext = new TenantContextService();

  const sessions = {
    resolveBySessionId: (sessionId: string): Promise<SessionPrincipal | null> => {
      scopes.push(tenantContext.tenantId);
      return Promise.resolve(live.includes(sessionId) ? principal(sessionId) : null);
    },
  } as unknown as SessionService;

  const server = {
    in: (room: string) => {
      rooms.push(room);
      return { fetchSockets: () => Promise.resolve(sockets) };
    },
  } as unknown as Server;

  const relay = new RealtimeRelayService(
    {} as unknown as MessageResourceService,
    {} as unknown as ConversationResourceService,
    {} as unknown as SlaBreachResourceService,
    {} as unknown as CannedResponseResourceService,
    {} as unknown as EscalationResourceService,
    {} as unknown as TenantHostnameService,
    sessions,
    tenantContext,
  );

  relay.attach(server);

  return { relay, rooms, scopes };
}

describe('a revocation reaching an open socket', () => {
  it('looks only in the affected user’s room', async () => {
    const { relay, rooms } = harnessFor([]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    expect(rooms).toEqual([userRoom(USER)]);
  });

  it('closes a socket whose session is gone, telling it why first', async () => {
    const dead = socketFor(DEAD_SESSION);
    const { relay } = harnessFor([dead]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    // The event before the close, so a client shows "you were signed out"
    // rather than treating it as a dropped connection and reconnecting into a
    // refused handshake.
    expect(dead.emitted).toEqual([
      { event: 'session.revoked', payload: { event: 'session.revoked', sessionId: DEAD_SESSION } },
    ]);
    expect(dead.disconnected).toBe(true);
  });

  it('leaves a socket whose session survived', async () => {
    // A signed-in password change spares the tab doing the typing, and
    // `DELETE /auth/sessions/{id}` kills exactly one device. Acting on the event
    // rather than on each session would sign both of those out.
    const live = socketFor(LIVE_SESSION);
    const dead = socketFor(DEAD_SESSION);
    const { relay } = harnessFor([live, dead]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    expect(live.disconnected).toBe(false);
    expect(live.emitted).toEqual([]);
    expect(dead.disconnected).toBe(true);
  });

  it('leaves every socket alone when the revocation revoked nothing', async () => {
    // The producer fires from an after-commit hook documented as safe to call
    // unconditionally, so "no sessions actually died" is a normal case and must
    // not drop live connections.
    const live = socketFor(LIVE_SESSION);
    const { relay } = harnessFor([live], [LIVE_SESSION]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    expect(live.disconnected).toBe(false);
  });

  it('re-reads the session inside the tenant the event named', async () => {
    // `resolveBySessionId` runs on `TenantPrisma`; with no tenant in scope it
    // would throw rather than answer, and RLS is what stops a session id from
    // another tenant resolving here.
    const { relay, scopes } = harnessFor([socketFor(DEAD_SESSION)]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    expect(scopes).toEqual([TENANT]);
  });

  it('closes a socket that somehow carries no principal', async () => {
    const anonymous = socketFor(null);
    const { relay } = harnessFor([anonymous]);

    await relay.onSessionsRevoked({ tenantId: TENANT, userId: USER });

    expect(anonymous.disconnected).toBe(true);
  });

  it('does nothing before a server is attached', async () => {
    const relay = new RealtimeRelayService(
      {} as unknown as MessageResourceService,
      {} as unknown as ConversationResourceService,
      {} as unknown as SlaBreachResourceService,
      {} as unknown as CannedResponseResourceService,
      {} as unknown as EscalationResourceService,
      {} as unknown as TenantHostnameService,
      {} as unknown as SessionService,
      new TenantContextService(),
    );

    await expect(
      relay.onSessionsRevoked({ tenantId: TENANT, userId: USER }),
    ).resolves.toBeUndefined();
  });
});
