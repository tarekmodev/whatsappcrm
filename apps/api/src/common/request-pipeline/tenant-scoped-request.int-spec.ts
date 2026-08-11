import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { permissionsForRole, type SessionResponse } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../../bootstrap';
import { PasswordService } from '../../identity/password.service';
import { AppLoggerService } from '../../observability/app-logger.service';
import { createPrismaClient } from '../../prisma/prisma-client.factory';
import type { PrismaClient } from '../../generated/prisma/client';

/**
 * TAR-58's acceptance criteria against a real PostgreSQL, a real session and the
 * real application: every request is tenant- and role-scoped from the session,
 * and never from anything a caller can set.
 *
 * `request-pipeline.http.spec` proves the wiring with fakes. Only this can prove
 * the two claims that are properties of the *system* rather than of any
 * function:
 *
 *   * a session issued in tenant A, presented at tenant B's hostname, is refused
 *     `tenant_mismatch` and paged — refused because the session row does not
 *     exist under B's row-level security, and *classified* by TAR-53's probe,
 *     which is the only reason the security event survives RLS at all;
 *   * that same session, used at its own host against an id belonging to tenant
 *     B, answers `not_found` and changes nothing — the ID vector, where RLS is
 *     the enforcement and the status code is what stops a 403 confirming the row
 *     exists.
 *
 * It also covers `GET /api/v1/message-templates`, which until TAR-58 declared no
 * guards at all and stood on a hand-written tenant check. It is here rather than
 * in `people-rbac.int-spec` for exactly that reason: the routes that were
 * *already* guarded were never the risk.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after it, so an
 * interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`.
 */

const TENANT_A = '58999999-9999-7999-8999-999999999901';
const TENANT_B = '58999999-9999-7999-8999-999999999902';
const HOST_A = 'tar58-a.app.localhost';
const HOST_B = 'tar58-b.app.localhost';
const UNKNOWN_HOST = 'tar58-nobody.app.localhost';

const ADMIN_A = '58999999-9999-7999-8999-9999999999a1';
const AGENT_B = '58999999-9999-7999-8999-9999999999b1';

const ADMIN_A_EMAIL = 'tar58-admin@example.invalid';
const PASSWORD = 'correct horse battery staple';

const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

describe('every API request is tenant- and role-scoped from the session', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;
  let sessionCookie: string;

  /** One request at `host`, unauthenticated. */
  const at = (host: string) => request.agent(app.getHttpServer() as Server).set('Host', host);

  /** One request at `host`, carrying tenant A's real session cookie. */
  const asAdminA = (host: string) => at(host).set('Cookie', sessionCookie);

  async function removeFixture(): Promise<void> {
    // `sessions`, `users` and `tenant_domains` all cascade from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    const passwordHash = await new PasswordService().hash(PASSWORD);

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar58-fixture-a', name: 'TAR-58 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar58-fixture-b', name: 'TAR-58 fixture B', status: 'active' },
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
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: ADMIN_A_EMAIL,
          passwordHash,
          name: 'A Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: 'tar58-agent@example.invalid',
          passwordHash,
          name: 'B Agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });
  }

  beforeAll(async () => {
    // The real session source, not the interim role stub — the whole point here
    // is that the cookie is what resolves the tenant and the role. Set before
    // the dynamic import below, because `ConfigModule.forRoot()` reads and
    // validates the environment the moment `app.module` is imported.
    process.env.AUTH_STUB_ENABLED = 'false';

    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    await removeFixture();
    await seed();

    const { AppModule } = await import('../../app.module');

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    await app.init();

    const login = await at(HOST_A)
      .post('/api/v1/auth/login')
      .send({ email: ADMIN_A_EMAIL, password: PASSWORD });

    expect(login.status).toBe(200);
    sessionCookie = (login.headers['set-cookie'] as unknown as string[])[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  /**
   * AC4. Neither route below ever declared a guard of its own —
   * `MessageTemplatesController` had none at all until this story. Both are
   * closed because the pipeline is global, not because anybody remembered.
   */
  describe('routes that declare no guards of their own are still behind the pipeline', () => {
    it.each([
      ['/api/v1/message-templates', 'a route that had no guards before TAR-58'],
      ['/api/v1/users', 'a route that declared its own'],
      ['/api/v1/auth/sessions', 'the caller’s own session list'],
    ])('refuses %s with no session (%s)', async (path) => {
      const response = await at(HOST_A).get(path);

      expect(response.status).toBe(401);
      expect(errorCodeOf(response)).toBe('unauthenticated');
    });

    it('answers tenant_not_found first at a host no tenant is served at', async () => {
      // Only `HostTenantGuard` produces this, and it produces it for a request
      // that has no session either — so the order in the published pipeline is
      // the order that ran.
      const response = await at(UNKNOWN_HOST).get('/api/v1/message-templates');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('serves the route to the session that belongs there', async () => {
      const response = await asAdminA(HOST_A).get('/api/v1/message-templates');

      expect(response.status).toBe(200);
    });
  });

  /**
   * AC2, the header vector: a real, valid session for tenant A replayed at
   * tenant B's hostname. This is the cheapest cross-tenant attempt there is, and
   * the one a client-supplied tenant id would have made trivial.
   *
   * `tenant_mismatch` survives RLS here only because of TAR-53's decision 2: the
   * tenant-scoped lookup matches zero rows — indistinguishable from an expired
   * cookie — and `SessionReplayProbe` then runs one read-only unscoped `SELECT`
   * to tell the two apart. Without that probe this would answer
   * `unauthenticated` and the security event would never fire, which is the
   * whole reason the probe was designed rather than discovered.
   */
  describe('a session replayed at another tenant’s host', () => {
    it('is refused with tenant_mismatch on a route it is otherwise entitled to', async () => {
      const entitled = await asAdminA(HOST_A).get('/api/v1/users');
      const replayed = await asAdminA(HOST_B).get('/api/v1/users');

      expect(entitled.status).toBe(200);
      expect(replayed.status).toBe(401);
      expect(errorCodeOf(replayed)).toBe('tenant_mismatch');
      // Neither tenant's people appear, and neither does the session's own
      // tenant — the probe's three uuids are for the log line, not the caller.
      expect(JSON.stringify(replayed.body)).not.toContain(AGENT_B);
      expect(JSON.stringify(replayed.body)).not.toContain(TENANT_A);
    });

    it('is still only unauthenticated for a cookie that is live nowhere', async () => {
      // The probe classifies; it does not widen. An invented token names no live
      // session, so it stays the ordinary rejection and pages nobody.
      const forged = await at(HOST_B)
        .set('Cookie', 'wac_session=not-a-real-token')
        .get('/api/v1/users');

      expect(forged.status).toBe(401);
      expect(errorCodeOf(forged)).toBe('unauthenticated');
    });

    /**
     * The structured line, as the deployed process writes it — through
     * `AppLoggerService`, not Nest's `Logger`, which is why the child is
     * intercepted rather than the console. The fields are what an alert rule
     * matches on and what an investigation reads.
     */
    it('emits the security event with both tenants, the session and the user', async () => {
      const emitted: Record<string, unknown>[] = [];
      const structured = jest.spyOn(AppLoggerService.prototype, 'structured').mockReturnValue({
        warn: (fields: Record<string, unknown>) => emitted.push(fields),
      } as unknown as ReturnType<AppLoggerService['structured']>);

      try {
        await asAdminA(HOST_B).get('/api/v1/users');

        const event = emitted.find((fields) => fields.event === 'auth.tenant_mismatch');

        expect(event).toMatchObject({
          hostTenantId: TENANT_B,
          sessionTenantId: TENANT_A,
          userId: ADMIN_A,
          method: 'GET',
          path: '/api/v1/users',
        });
        // The session id is there to identify which credential to revoke; the
        // token that names it is in neither the line nor the response.
        expect(typeof event?.sessionId).toBe('string');
      } finally {
        structured.mockRestore();
      }
    });
  });

  /**
   * AC2, the ID vector: the same admin, at their own host, naming a row that
   * belongs to tenant B. RLS is what refuses it — the statement matches zero
   * rows — and `not_found` rather than `forbidden` is what stops the status code
   * confirming the id exists somewhere.
   */
  describe('an id belonging to another tenant', () => {
    it('is absent from a list, whatever the caller’s role', async () => {
      const response = await asAdminA(HOST_A).get('/api/v1/users');

      expect(response.status).toBe(200);
      // An admin is an admin of one tenant. There is no role in the matrix that
      // widens a list past the tenant boundary, because the boundary is RLS.
      expect(JSON.stringify(response.body)).not.toContain(AGENT_B);
    });

    it('answers not_found on a mutation, and changes nothing', async () => {
      const response = await asAdminA(HOST_A)
        .patch(`/api/v1/users/${AGENT_B}`)
        .send({ name: 'Renamed across the boundary' });

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');

      const agentB = await systemPrisma.user.findUnique({
        where: { id: AGENT_B },
        select: { name: true },
      });

      expect(agentB?.name).toBe('B Agent');
    });
  });

  /**
   * AC3: the role claim is resolved from the session and published for
   * downstream authorization. `PermissionGuard` is its first consumer; TAR-22's
   * console reads the same array off this response.
   */
  it('resolves the role and its permissions from the session', async () => {
    const response = await asAdminA(HOST_A).get('/api/v1/auth/session');

    expect(response.status).toBe(200);

    const { user } = response.body as SessionResponse;

    expect(user).toMatchObject({ userId: ADMIN_A, tenantId: TENANT_A, role: 'admin' });
    expect(user.permissions).toHaveLength(permissionsForRole('admin').length);
  });
});

/** Loaded from the repository-root `.env` by `jest.int.setup.cjs`. */
function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. These tests need a real database: ` +
        'copy .env.example to .env and run pnpm db:up && pnpm db:migrate:deploy && ' +
        'pnpm db:roles && pnpm db:roles:login.',
    );
  }

  return value;
}
