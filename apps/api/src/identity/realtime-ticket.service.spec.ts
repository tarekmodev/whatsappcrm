import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AUTH_POLICY, permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import type { AuthRedisClient } from './auth-redis.client';
import { RealtimeTicketUnavailableError } from './identity.errors';
import { RealtimeTicketService } from './realtime-ticket.service';
import { RealtimeTicketStore } from './realtime-ticket.store';

/**
 * The handshake credential (TAR-180): what a ticket carries, how long it lives,
 * and that it can be spent exactly once.
 *
 * Run against a fake Redis rather than a mocked store, on
 * `login-throttle.service.spec`'s reasoning: single-use is a property of the
 * *commands* — `SET … NX` and `GETDEL` — and a mocked store asserting that
 * `consume` was called would prove only that a method exists. What is under test
 * here is that the second presentation of a ticket finds nothing.
 *
 * The three properties worth reading twice: the plaintext ticket never reaches
 * the store, so a Redis dump yields no usable credential; the claims come from
 * the resolved principal and from nowhere else, so there is no input a caller
 * could aim at another tenant; and an unreachable Redis refuses to issue rather
 * than handing back a ticket no handshake could redeem.
 */

const TENANT_A = '80111111-1111-7111-8111-111111111101';
const TENANT_B = '80111111-1111-7111-8111-111111111102';
const USER_A = '80111111-1111-7111-8111-1111111111a1';
const USER_B = '80111111-1111-7111-8111-1111111111a2';
const SESSION_A = '80111111-1111-7111-8111-1111111111f1';
const SESSION_B = '80111111-1111-7111-8111-1111111111f2';

const REALTIME_URL = 'https://realtime.example.invalid';

/** The digest the store is expected to key by, restated so a change is deliberate. */
function digestOf(ticket: string): string {
  return createHash('sha256').update(ticket, 'utf8').digest('hex');
}

interface StoredValue {
  value: string;
  ttlMs: number;
}

/**
 * Just enough Redis: the two commands the store issues, against a `Map`. `set`
 * honours `NX` and `getdel` removes what it returns, because those are exactly
 * the semantics single-use rests on.
 */
class FakeRedis {
  readonly entries = new Map<string, StoredValue>();

  set(key: string, value: string, unit: 'PX', ttlMs: number, mode: 'NX'): Promise<'OK' | null> {
    expect(unit).toBe('PX');
    expect(mode).toBe('NX');

    if (this.entries.has(key)) {
      return Promise.resolve(null);
    }

    this.entries.set(key, { value, ttlMs });

    return Promise.resolve('OK');
  }

  getdel(key: string): Promise<string | null> {
    const stored = this.entries.get(key) ?? null;

    this.entries.delete(key);

    return Promise.resolve(stored === null ? null : stored.value);
  }
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

interface Harness {
  tickets: RealtimeTicketService;
  redis: FakeRedis;
}

function harnessFor(options: { redisDown?: boolean } = {}): Harness {
  const redis = new FakeRedis();

  const redisClient = {
    run: <T>(_operation: string, work: (client: unknown) => Promise<T>): Promise<T | null> =>
      options.redisDown === true ? Promise.resolve(null) : work(redis),
  } as unknown as AuthRedisClient;

  const config = {
    get: (key: string) => (key === 'REALTIME_URL' ? REALTIME_URL : undefined),
  } as unknown as ConfigService;

  return {
    tickets: new RealtimeTicketService(new RealtimeTicketStore(redisClient), config),
    redis,
  };
}

describe('issuing a realtime ticket', () => {
  it('answers the ticket, its deadline and where to present it', async () => {
    const before = Date.now();
    const { tickets } = harnessFor();

    const issued = await tickets.issue(principal());

    expect(issued.ticket).toEqual(expect.any(String));
    expect(issued.realtimeUrl).toBe(REALTIME_URL);
    expect(Date.parse(issued.expiresAt)).toBeGreaterThanOrEqual(
      before + AUTH_POLICY.realtimeTicketTtlMs,
    );
    expect(Date.parse(issued.expiresAt)).toBeLessThanOrEqual(
      Date.now() + AUTH_POLICY.realtimeTicketTtlMs,
    );
  });

  it('stores the digest and never the ticket itself', async () => {
    const { tickets, redis } = harnessFor();

    const issued = await tickets.issue(principal());

    const [key] = [...redis.entries.keys()];

    expect(key).toBe(`wac:auth:rt:${digestOf(issued.ticket)}`);
    // A `KEYS`/`GET` dump must yield nothing anybody could present. The
    // plaintext exists only in the response body.
    expect(JSON.stringify([...redis.entries])).not.toContain(issued.ticket);
  });

  it('binds the ticket to the caller’s tenant, user, role and session', async () => {
    const { tickets, redis } = harnessFor();

    const issued = await tickets.issue(principal({ role: 'supervisor' }));

    await expect(tickets.consume(issued.ticket)).resolves.toEqual({
      userId: USER_A,
      tenantId: TENANT_A,
      role: 'supervisor',
      sessionId: SESSION_A,
    });
    expect(redis.entries.size).toBe(0);
  });

  it('expires on the published TTL rather than on a lifetime of its own', async () => {
    const { tickets, redis } = harnessFor();

    await tickets.issue(principal());

    expect([...redis.entries.values()][0]?.ttlMs).toBe(AUTH_POLICY.realtimeTicketTtlMs);
    // A minute, not an hour: the ticket is fetched immediately before the socket
    // opens, and every second past that is replay window for a bearer token the
    // cookie's protections do not cover.
    expect(AUTH_POLICY.realtimeTicketTtlMs).toBeLessThanOrEqual(5 * 60 * 1000);
  });

  it('mints a distinct ticket every time', async () => {
    const { tickets } = harnessFor();

    const first = await tickets.issue(principal());
    const second = await tickets.issue(principal());

    expect(first.ticket).not.toBe(second.ticket);
  });

  it('refuses rather than issuing one the handshake could never redeem', async () => {
    const { tickets, redis } = harnessFor({ redisDown: true });

    await expect(tickets.issue(principal())).rejects.toBeInstanceOf(RealtimeTicketUnavailableError);
    expect(redis.entries.size).toBe(0);
  });
});

describe('spending a realtime ticket', () => {
  it('works once and never again', async () => {
    const { tickets } = harnessFor();

    const issued = await tickets.issue(principal());

    await expect(tickets.consume(issued.ticket)).resolves.not.toBeNull();
    // The second socket presenting the same string — a replay, or the same tab
    // reconnecting — finds nothing.
    await expect(tickets.consume(issued.ticket)).resolves.toBeNull();
  });

  it('answers null for a ticket nobody issued', async () => {
    const { tickets } = harnessFor();

    await expect(tickets.consume('not-a-ticket')).resolves.toBeNull();
  });

  it('answers null when Redis is unreachable, rather than admitting the handshake', async () => {
    const { tickets } = harnessFor({ redisDown: true });

    await expect(tickets.consume('anything')).resolves.toBeNull();
  });

  it('rejects a stored value that no longer matches the claim shape', async () => {
    const { tickets, redis } = harnessFor();

    // What a deploy that changed the claims leaves readable for up to a minute.
    // A gateway authorising on a half-populated object is worse than a refused
    // handshake, so the entry is treated as a dead ticket — and consumed anyway.
    redis.entries.set(`wac:auth:rt:${digestOf('stale')}`, {
      value: JSON.stringify({ userId: USER_A }),
      ttlMs: AUTH_POLICY.realtimeTicketTtlMs,
    });

    await expect(tickets.consume('stale')).resolves.toBeNull();
    expect(redis.entries.size).toBe(0);
  });

  it('keeps two tenants’ tickets apart', async () => {
    const { tickets } = harnessFor();

    const a = await tickets.issue(principal());
    const b = await tickets.issue(
      principal({ tenantId: TENANT_B, userId: USER_B, sessionId: SESSION_B }),
    );

    // Spending one leaves the other untouched, and neither carries the other's
    // tenant — the room a socket joins comes from these claims, so a ticket that
    // could name the wrong tenant is the whole leak.
    await expect(tickets.consume(a.ticket)).resolves.toMatchObject({ tenantId: TENANT_A });
    await expect(tickets.consume(b.ticket)).resolves.toMatchObject({ tenantId: TENANT_B });
  });
});
