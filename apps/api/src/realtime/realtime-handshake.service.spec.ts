import { permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { RealtimeTicketService } from '../identity/realtime-ticket.service';
import type { RealtimeTicketClaims } from '../identity/realtime-ticket.store';
import type { SessionService } from '../identity/session.service';
import { RealtimeHandshakeService } from './realtime-handshake.service';

/**
 * Who a handshake payload authorises (TAR-69).
 *
 * The three properties worth reading twice, because each is one edit away from
 * being a cross-tenant socket:
 *
 *   * a ticket is spent whether or not the session behind it survives, so a
 *     refused handshake cannot be retried with the same string;
 *   * the session is re-read rather than trusted from the claims, so a
 *     revocation inside the ticket's sixty seconds is honoured and a role change
 *     is picked up;
 *   * the lookup happens inside a tenant scope opened from the **ticket**, never
 *     from anything the client sent — the payload is one opaque string and has
 *     no room for a tenant.
 */

const TENANT_A = '80111111-1111-7111-8111-111111111101';
const TENANT_B = '80111111-1111-7111-8111-111111111102';
const USER_A = '80111111-1111-7111-8111-1111111111a1';
const USER_B = '80111111-1111-7111-8111-1111111111a2';
const SESSION_A = '80111111-1111-7111-8111-1111111111f1';

function claims(overrides: Partial<RealtimeTicketClaims> = {}): RealtimeTicketClaims {
  return { userId: USER_A, tenantId: TENANT_A, role: 'agent', sessionId: SESSION_A, ...overrides };
}

function principal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
  return {
    userId: USER_A,
    tenantId: TENANT_A,
    email: 'ada@acme.invalid',
    displayName: 'Ada Agent',
    role: 'agent',
    permissions: [...permissionsForRole('agent')],
    teamIds: [],
    sessionId: SESSION_A,
    expiresAt: '2036-12-31T23:59:59.000Z',
    ...overrides,
  };
}

interface HarnessOptions {
  readonly claims?: RealtimeTicketClaims | null;
  readonly principal?: SessionPrincipal | null;
  readonly sessionLookupFails?: boolean;
}

interface Harness {
  readonly handshake: RealtimeHandshakeService;
  readonly consumed: string[];
  /** The tenant in scope each time the session was looked up. */
  readonly scopes: (string | null)[];
}

function harnessFor(options: HarnessOptions = {}): Harness {
  const consumed: string[] = [];
  const scopes: (string | null)[] = [];
  const tenantContext = new TenantContextService();

  const tickets = {
    consume: (ticket: string): Promise<RealtimeTicketClaims | null> => {
      consumed.push(ticket);
      return Promise.resolve(options.claims === undefined ? claims() : options.claims);
    },
  } as unknown as RealtimeTicketService;

  const sessions = {
    resolveBySessionId: (): Promise<SessionPrincipal | null> => {
      scopes.push(tenantContext.tenantId);

      if (options.sessionLookupFails === true) {
        return Promise.reject(new Error('the database is unreachable'));
      }

      return Promise.resolve(options.principal === undefined ? principal() : options.principal);
    },
  } as unknown as SessionService;

  return {
    handshake: new RealtimeHandshakeService(tickets, sessions, tenantContext),
    consumed,
    scopes,
  };
}

describe('authenticating a realtime handshake', () => {
  it('answers the principal the live session names', async () => {
    const { handshake } = harnessFor();

    const authenticated = await handshake.authenticate({ ticket: 'a-ticket' });

    expect(authenticated?.principal).toEqual(principal());
    expect(authenticated?.requestId).toEqual(expect.any(String));
  });

  it('resolves the session inside the tenant the ticket named', async () => {
    const { handshake, scopes } = harnessFor();

    await handshake.authenticate({ ticket: 'a-ticket' });

    // The lookup runs on `TenantPrisma`, so this is what makes RLS — rather than
    // a comparison somebody has to remember to write — refuse a session id from
    // another tenant.
    expect(scopes).toEqual([TENANT_A]);
  });

  it.each([
    ['nothing at all', undefined],
    ['a payload that is not an object', 'a-ticket'],
    ['a payload with no ticket', {}],
    ['an empty ticket', { ticket: '' }],
  ])('refuses %s without spending anything', async (_case, auth) => {
    const { handshake, consumed } = harnessFor();

    await expect(handshake.authenticate(auth)).resolves.toBeNull();
    expect(consumed).toEqual([]);
  });

  it('refuses a ticket that was never issued, has expired, or was already spent', async () => {
    const { handshake } = harnessFor({ claims: null });

    await expect(handshake.authenticate({ ticket: 'a-ticket' })).resolves.toBeNull();
  });

  it('refuses once the session behind the ticket is gone', async () => {
    // Signed out everywhere, deactivated, or simply expired within the ticket's
    // sixty seconds. The ticket is still perfectly good and must buy nothing.
    const { handshake, consumed } = harnessFor({ principal: null });

    await expect(handshake.authenticate({ ticket: 'a-ticket' })).resolves.toBeNull();
    expect(consumed).toEqual(['a-ticket']);
  });

  it('refuses when the session lookup fails rather than admitting the socket', async () => {
    const { handshake } = harnessFor({ sessionLookupFails: true });

    await expect(handshake.authenticate({ ticket: 'a-ticket' })).resolves.toBeNull();
  });

  it('refuses when the ticket and the session row name different tenants', async () => {
    const { handshake } = harnessFor({
      claims: claims({ tenantId: TENANT_B }),
      principal: principal(),
    });

    await expect(handshake.authenticate({ ticket: 'a-ticket' })).resolves.toBeNull();
  });

  it('refuses when the ticket and the session row name different users', async () => {
    const { handshake } = harnessFor({ principal: principal({ userId: USER_B }) });

    await expect(handshake.authenticate({ ticket: 'a-ticket' })).resolves.toBeNull();
  });

  it('carries the role the session holds now, not the one the ticket froze', async () => {
    // A promotion or demotion inside the ticket's window. The gateway authorises
    // `conversation.subscribe` on these permissions, so a stale copy would be a
    // stale authorization for as long as the socket stayed open.
    const { handshake } = harnessFor({
      claims: claims({ role: 'agent' }),
      principal: principal({
        role: 'supervisor',
        permissions: [...permissionsForRole('supervisor')],
      }),
    });

    const authenticated = await handshake.authenticate({ ticket: 'a-ticket' });

    expect(authenticated?.principal.role).toBe('supervisor');
    expect(authenticated?.principal.permissions).toContain('conversation:read_all');
  });
});
