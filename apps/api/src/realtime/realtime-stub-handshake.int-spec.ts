import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { REALTIME_PATH, type RealtimeTicketResponse } from '@whatsappcrm/contracts';
import request from 'supertest';
import { io, type Socket as ClientSocket } from 'socket.io-client';
import { configureApp } from '../bootstrap';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * TAR-576, end to end: **a browser can open a realtime socket while
 * `AUTH_STUB_ENABLED=true`.**
 *
 * The stub named a `sessionId` that matched no row in `sessions`, and the
 * handshake does not take the ticket's word for who is behind it — it re-reads
 * the session, deliberately, because that re-read is what lets a revocation
 * reach an already-open socket. Against zero rows every upgrade was refused,
 * so no realtime feature could be demonstrated in a running browser locally and
 * TAR-486's own acceptance criterion could not be met through the product.
 *
 * Only an integration test can close it. The bug lived in the seam between
 * three things a unit test replaces with a double: the principal source's
 * write, RLS on `sessions`, and `resolveBySessionId`'s liveness predicates
 * against the database's clock. `realtime.gateway.spec.ts` stubs the session
 * lookup and so passed throughout.
 *
 * So this runs the whole path the browser runs, in order:
 *
 *   1. `POST /api/v1/auth/realtime-ticket` at a tenant's host, with the
 *      `x-dev-role` the console's role switch sets;
 *   2. a real Socket.IO client presenting that ticket at the API's own origin,
 *      as the upgrade does — no host, no cookie, nothing but the ticket.
 *
 * Two tenants throughout, because the id the stub derives is the primary key of
 * a table every tenant shares: a constant would be one row for the whole
 * database, and whichever tenant wrote it first would own it. That is the
 * regression this file is here to catch a second time.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after, so an
 * interrupted run cleans up on the next one. **Redis is required** — a realtime
 * ticket lives there and `RealtimeTicketStore` deliberately does not degrade.
 *
 * Prerequisites — the four commands in the README, and `pnpm db:up` brings the
 * Redis this needs up alongside Postgres:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '57666666-6666-7666-8666-666666660001';
const TENANT_B = '57666666-6666-7666-8666-666666660002';
const HOST_A = 'tar576-a.app.localhost';
const HOST_B = 'tar576-b.app.localhost';

const ADMIN_A = '57666666-6666-7666-8666-6666666600a1';
const AGENT_A = '57666666-6666-7666-8666-6666666600a2';
const ADMIN_B = '57666666-6666-7666-8666-6666666600b1';

const TICKET_ENDPOINT = '/api/v1/auth/realtime-ticket';

interface LiveSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  token_hash: string;
}

interface SessionRow extends LiveSessionRow {
  revoked_at: Date | null;
  created_at: Date;
  absolute_expires_at: Date;
}

describe('the realtime handshake under the interim auth stub', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;
  let url: string;
  const clients: ClientSocket[] = [];

  /** The ticket the console would fetch, for `role` at `host`. */
  async function fetchTicket(
    host: string,
    role: 'admin' | 'agent',
  ): Promise<RealtimeTicketResponse> {
    const response = await request(app.getHttpServer() as Server)
      .post(TICKET_ENDPOINT)
      .set('Host', host)
      .set('x-dev-role', role);

    expect(response.status).toBe(200);

    return response.body as RealtimeTicketResponse;
  }

  /**
   * Opens a socket the way the browser does — at the API's own origin, carrying
   * nothing but the ticket — and resolves once it is connected.
   *
   * Rejects with the refusal message on `connect_error`, so a regression reads
   * as `unauthorized` in the failure output rather than as a timeout.
   */
  async function connectWith(ticket: string): Promise<ClientSocket> {
    const client = io(url, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      auth: { ticket },
      forceNew: true,
      reconnection: false,
    });

    clients.push(client);

    await new Promise<void>((resolve, reject) => {
      client.on('connect', resolve);
      client.on('connect_error', reject);
    });

    return client;
  }

  /** Every live session in `tenantId`, read across tenants as an operator would. */
  async function liveSessions(tenantId: string): Promise<LiveSessionRow[]> {
    return await systemPrisma.$queryRaw<LiveSessionRow[]>`
      SELECT id, tenant_id, user_id, token_hash
        FROM sessions
       WHERE tenant_id = ${tenantId}::uuid
         AND revoked_at IS NULL
         AND expires_at > now()
         AND absolute_expires_at > now()
    `;
  }

  /** The stub's row for `userId`, live or not, as an operator would read it. */
  async function sessionOf(userId: string): Promise<SessionRow | undefined> {
    const [row] = await systemPrisma.$queryRaw<SessionRow[]>`
      SELECT id, tenant_id, user_id, token_hash, revoked_at, created_at, absolute_expires_at
        FROM sessions
       WHERE user_id = ${userId}::uuid
    `;

    return row;
  }

  async function removeFixture(): Promise<void> {
    // Sessions, domains, settings and users all cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar576-fixture-a', name: 'TAR-576 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar576-fixture-b', name: 'TAR-576 fixture B', status: 'active' },
      ],
    });
    await systemPrisma.tenantDomain.createMany({
      data: [
        {
          tenantId: TENANT_A,
          hostname: HOST_A,
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
        {
          tenantId: TENANT_B,
          hostname: HOST_B,
          kind: 'platform',
          isPrimary: true,
          verifiedAt: new Date(),
        },
      ],
    });
    await systemPrisma.tenantSettings.createMany({
      data: [
        { tenantId: TENANT_A, timezone: 'Europe/London' },
        { tenantId: TENANT_B, timezone: 'Europe/London' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: 'admin@tar576-a.invalid',
          name: 'A Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar576-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: ADMIN_B,
          tenantId: TENANT_B,
          email: 'admin@tar576-b.invalid',
          name: 'B Admin',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  }

  beforeAll(async () => {
    // Set before `app.module` is *loaded*: `ConfigModule.forRoot()` reads the
    // environment the moment the file is imported. Hence the dynamic import.
    process.env.AUTH_STUB_ENABLED = 'true';

    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    await removeFixture();
    await seed();

    const { AppModule } = await import('../app.module');

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    // Port 0 so the suite never collides with a developer's running API, and the
    // address read from the server rather than from `getUrl()`, which answers an
    // IPv6 literal on some hosts that the client then cannot parse.
    await app.listen(0);

    url = `http://127.0.0.1:${portOf(app)}`;
  }, 60_000);

  afterAll(async () => {
    while (clients.length > 0) {
      const client = clients.pop();

      client?.removeAllListeners();
      client?.close();
    }

    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  it('connects a socket for a ticket the stub issued', async () => {
    const ticket = await fetchTicket(HOST_A, 'admin');

    const client = await connectWith(ticket.ticket);

    expect(client.connected).toBe(true);
  });

  it('backs that ticket with a live session row for the user it names', async () => {
    await fetchTicket(HOST_A, 'admin');
    await fetchTicket(HOST_A, 'admin');

    const mine = (await liveSessions(TENANT_A)).filter((session) => session.user_id === ADMIN_A);

    expect(mine[0]?.tenant_id).toBe(TENANT_A);
    // One row for that user however many times they ask, not one per request:
    // the id is derived, so a page load leaves no trail behind it.
    expect(mine).toHaveLength(1);
  });

  it('gives each tenant its own session, so neither locks the other out', async () => {
    const [here, there] = await Promise.all([
      fetchTicket(HOST_A, 'admin'),
      fetchTicket(HOST_B, 'admin'),
    ]);

    // Both connect. With one hardcoded id, the second tenant's ticket named the
    // first tenant's row, which RLS hides from it — the socket that broke.
    await expect(connectWith(here.ticket)).resolves.toBeDefined();
    await expect(connectWith(there.ticket)).resolves.toBeDefined();

    const [inA] = (await liveSessions(TENANT_A)).filter((row) => row.user_id === ADMIN_A);
    const [inB] = await liveSessions(TENANT_B);

    expect(inA?.id).not.toBe(inB?.id);
    // Nothing guessable is written either: the digest is of a token generated
    // and forgotten, so no cookie can ever be constructed to match it.
    expect(inA?.token_hash).not.toBe(inB?.token_hash);
  });

  it('gives each role its own session, because the stub resolves a different user', async () => {
    await fetchTicket(HOST_A, 'admin');
    await fetchTicket(HOST_A, 'agent');

    const sessions = await liveSessions(TENANT_A);

    expect(sessions.map((session) => session.user_id).sort()).toEqual([ADMIN_A, AGENT_A].sort());
  });

  /**
   * The three lines of the upsert nothing else would fail on, and the reason
   * they are here: under the stub there is no login to perform, so a session
   * that dies stays dead until somebody reseeds — TAR-576 again, on a timer.
   * Deleting any of them leaves every case above green.
   */
  describe('a stub session that has died', () => {
    it('is revived after a revocation, the way signing back in would', async () => {
      await fetchTicket(HOST_A, 'agent');

      // What `SessionRevocationService` writes when an admin edits a team
      // membership or a role — `TeamsService` and `UsersService` both reach it.
      await systemPrisma.$executeRaw`
        UPDATE sessions
           SET revoked_at = now(), revoked_reason = 'deactivation'
         WHERE user_id = ${AGENT_A}::uuid
      `;

      const ticket = await fetchTicket(HOST_A, 'agent');

      await expect(connectWith(ticket.ticket)).resolves.toBeDefined();
      expect((await sessionOf(AGENT_A))?.revoked_at).toBeNull();
    });

    it('is restarted once it reaches its absolute cap', async () => {
      await fetchTicket(HOST_A, 'agent');

      // A developer's stack left running past `sessionAbsoluteMs`. The idle
      // window slides on use; the cap deliberately does not, so without this
      // the row is unresolvable for ever and no login exists to replace it.
      await systemPrisma.$executeRaw`
        UPDATE sessions
           SET created_at = now() - interval '31 days',
               absolute_expires_at = now() - interval '1 day'
         WHERE user_id = ${AGENT_A}::uuid
      `;

      const ticket = await fetchTicket(HOST_A, 'agent');
      const restarted = await sessionOf(AGENT_A);

      await expect(connectWith(ticket.ticket)).resolves.toBeDefined();
      expect(restarted?.absolute_expires_at.getTime()).toBeGreaterThan(Date.now());
      // Restamped with the cap, so `absolute_expires_at = created_at +
      // sessionAbsoluteMs` still reads true of the row.
      expect(restarted?.created_at.getTime()).toBeGreaterThan(Date.now() - 60_000);
    });

    it('does not have its cap pushed forward by simply being used', async () => {
      await fetchTicket(HOST_A, 'agent');
      const before = await sessionOf(AGENT_A);

      await fetchTicket(HOST_A, 'agent');
      const after = await sessionOf(AGENT_A);

      // The whole point of a cap is that use does not extend it — the sliding
      // `expires_at` is what a request moves.
      expect(after?.absolute_expires_at).toEqual(before?.absolute_expires_at);
      expect(after?.created_at).toEqual(before?.created_at);
    });
  });

  it('still refuses a socket presenting no ticket the API issued', async () => {
    // The fix supplies a session; it does not weaken the handshake. A random
    // string is what a ticket looks like to anyone who did not fetch one.
    await expect(connectWith('not-a-ticket-anybody-issued')).rejects.toThrow('unauthorized');
  });

  it('refuses the same ticket a second time', async () => {
    const ticket = await fetchTicket(HOST_A, 'admin');

    await connectWith(ticket.ticket);

    // Single use survives the fix: `consume` is a `GETDEL`, and a live session
    // row does not make a spent ticket redeemable again.
    await expect(connectWith(ticket.ticket)).rejects.toThrow('unauthorized');
  });
});

function portOf(app: INestApplication): number {
  const address = (app.getHttpServer() as { address: () => unknown }).address();

  if (typeof address !== 'object' || address === null || !('port' in address)) {
    throw new Error('The test server is not listening on a TCP port.');
  }

  return (address as { port: number }).port;
}

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} must be set to run this suite. See the header for the commands.`);
  }

  return value;
}
