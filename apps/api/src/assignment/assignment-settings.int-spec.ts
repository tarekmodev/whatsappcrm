import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ASSIGNMENT_POLICY,
  type AssignmentSettingsResponse,
  type CursorPage,
  type OwnAssignmentCapacityResponse,
  type UserResponse,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * The cap-editing surface (TAR-384, 0008 amendment 4), end to end against a real
 * PostgreSQL and the real request pipeline — host resolution, principal,
 * permission guard, RLS, all of it.
 *
 * Three claims are not testable anywhere else, and they are why this suite
 * exists rather than more unit tests:
 *
 *   * **The gate is `assignment_rule:*`, not `user:update`.** An agent is
 *     refused both endpoints and is handed `null` for a colleague's workload on
 *     a route they are allowed to call. That last one is the leak the design
 *     exists to prevent: `user:read` is held by every agent.
 *   * **Nothing crosses the tenant boundary.** Every case runs in two tenants
 *     and asserts A cannot read or move B's numbers — including patching B's
 *     user id from A's host, which answers `not_found` and never `forbidden`,
 *     because a 403 would confirm the id exists.
 *   * **A cap change needs no restart and no invalidation** — the parent story's
 *     third acceptance criterion. Asserted as the property it actually is: the
 *     column the resolver reads holds the new number the moment the `PATCH`
 *     returns, in the same process, with nothing cleared in between.
 *
 * The role is supplied by the interim stub (`x-dev-role`), exactly as
 * `people-rbac.int-spec.ts` does. The stub changes *who* the principal is; every
 * guard, predicate and policy under test is the real one.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after, so an interrupted
 * run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '84888888-8888-7888-8888-888888888401';
const TENANT_B = '84888888-8888-7888-8888-888888888402';
const HOST_A = 'tar384-a.app.localhost';
const HOST_B = 'tar384-b.app.localhost';

const ADMIN_A = '84888888-8888-7888-8888-8888888884a0';
const SUPERVISOR_A = '84888888-8888-7888-8888-8888888884a1';
const AGENT_A = '84888888-8888-7888-8888-8888888884a2';
const SUPERVISOR_B = '84888888-8888-7888-8888-8888888884b0';
const AGENT_B = '84888888-8888-7888-8888-8888888884b1';

type Role = 'agent' | 'supervisor' | 'admin';

const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

const settingsOf = (response: request.Response): AssignmentSettingsResponse =>
  response.body as AssignmentSettingsResponse;

const ownCapacityOf = (response: request.Response): OwnAssignmentCapacityResponse =>
  response.body as OwnAssignmentCapacityResponse;

const userOf = (response: request.Response): UserResponse => response.body as UserResponse;

const usersPageOf = (response: request.Response): CursorPage<UserResponse> =>
  response.body as CursorPage<UserResponse>;

describe('assignment settings API', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;
  /** Ticket numbers and phone numbers are unique per tenant; this keeps both so. */
  let sequence = 384_000;

  /** One request as `role`, at `host`. The two axes every case below varies. */
  function call(host: string, role: Role) {
    return request
      .agent(app.getHttpServer() as Server)
      .set('Host', host)
      .set('x-dev-role', role);
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar384-fixture-a', name: 'TAR-384 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar384-fixture-b', name: 'TAR-384 fixture B', status: 'active' },
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
          email: 'admin@tar384-a.invalid',
          name: 'A Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'super@tar384-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar384-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUPERVISOR_B,
          tenantId: TENANT_B,
          email: 'super@tar384-b.invalid',
          name: 'B Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: 'agent@tar384-b.invalid',
          name: 'B Agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });
  }

  beforeAll(async () => {
    // The stub supplies a role before TAR-35, and has to be set before
    // `app.module` is *loaded* — `ConfigModule.forRoot()` reads and validates
    // the environment at import time. Hence the dynamic import below.
    process.env.AUTH_STUB_ENABLED = 'true';

    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    await removeFixture();
    await seed();

    const { AppModule } = await import('../app.module');

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Each test starts from the seeded shape, so they pass in any order.
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.contact.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.tenantSettings.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.updateMany({
      where: { id: { in: [ADMIN_A, SUPERVISOR_A, SUPERVISOR_B, AGENT_A, AGENT_B] } },
      data: { maxConcurrentTickets: null },
    });
  });

  /**
   * An active ticket in tenant A held by `userId` — what `activeTicketCount`
   * counts. A fresh contact each time, because `tickets_one_active_per_contact`
   * permits exactly one.
   */
  async function assignTicket(userId: string): Promise<void> {
    sequence += 1;

    const contact = await systemPrisma.contact.create({
      data: { tenantId: TENANT_A, phoneE164: `+2010000${sequence}` },
      select: { id: true },
    });

    await systemPrisma.ticket.create({
      data: {
        tenantId: TENANT_A,
        number: sequence,
        status: 'open',
        contactId: contact.id,
        assignedUserId: userId,
      },
    });
  }

  describe('the tenant default', () => {
    it('answers the built-in fallback when the tenant has no settings row', async () => {
      const response = await call(HOST_A, 'supervisor').get('/api/v1/assignment-settings');

      expect(response.status).toBe(200);
      // Not a 404: this tenant has a working effective default, and the number
      // is the one `RotationFallbackResolver` coalesces to.
      expect(settingsOf(response)).toEqual({
        defaultMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
        updatedAt: null,
      });
    });

    it('creates the row on the first PATCH, and reads it back', async () => {
      const written = await call(HOST_A, 'supervisor')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 11 });

      expect(written.status).toBe(200);
      expect(settingsOf(written).defaultMaxConcurrentTickets).toBe(11);
      expect(settingsOf(written).updatedAt).not.toBeNull();

      const read = await call(HOST_A, 'supervisor').get('/api/v1/assignment-settings');

      expect(settingsOf(read).defaultMaxConcurrentTickets).toBe(11);
    });

    it('audits the write against the tenant, from and to', async () => {
      await call(HOST_A, 'admin')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 11 });
      await call(HOST_A, 'admin')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 4 });

      const trail = await systemPrisma.auditLog.findMany({
        where: { tenantId: TENANT_A, action: 'assignment_settings.updated' },
        orderBy: { createdAt: 'asc' },
        select: { targetType: true, targetId: true, metadata: true },
      });

      expect(trail).toEqual([
        { targetType: 'tenant_settings', targetId: TENANT_A, metadata: { from: null, to: 11 } },
        { targetType: 'tenant_settings', targetId: TENANT_A, metadata: { from: 11, to: 4 } },
      ]);
    });

    it('refuses a value outside the bounds the CHECK constraints enforce', async () => {
      for (const value of [0, 1001, 2.5, 'lots']) {
        const response = await call(HOST_A, 'supervisor')
          .patch('/api/v1/assignment-settings')
          .send({ defaultMaxConcurrentTickets: value });

        expect(response.status).toBe(400);
        expect(errorCodeOf(response)).toBe('validation_failed');
      }
    });

    it('refuses an empty body rather than answering 200 to a no-op', async () => {
      const response = await call(HOST_A, 'supervisor')
        .patch('/api/v1/assignment-settings')
        .send({});

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });
  });

  describe('who may reach it', () => {
    it('refuses an agent the read', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/assignment-settings');

      expect(response.status).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
    });

    it('refuses an agent the write, and writes nothing', async () => {
      const response = await call(HOST_A, 'agent')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 2 });

      expect(response.status).toBe(403);
      expect(await systemPrisma.tenantSettings.count({ where: { tenantId: TENANT_A } })).toBe(0);
    });

    it('lets an agent read their own capacity, which is the resource they are', async () => {
      await systemPrisma.user.update({
        where: { id: AGENT_A },
        data: { maxConcurrentTickets: 3 },
      });
      await assignTicket(AGENT_A);

      const response = await call(HOST_A, 'agent').get('/api/v1/assignment-settings/me');

      expect(response.status).toBe(200);
      expect(ownCapacityOf(response)).toEqual({
        maxConcurrentTickets: 3,
        effectiveMaxConcurrentTickets: 3,
        activeTicketCount: 1,
        defaultMaxConcurrentTickets: ASSIGNMENT_POLICY.defaultMaxConcurrentTickets,
      });
    });

    it('gives the agent no way to write their own limit', async () => {
      // There is no route, and the absence is the point: `me` is read-only, so
      // an agent cannot lift the cap being applied to them.
      const response = await call(HOST_A, 'agent')
        .patch('/api/v1/assignment-settings/me')
        .send({ maxConcurrentTickets: 50 });

      expect(response.status).toBe(404);
    });
  });

  describe('the per-agent override on PATCH /users/{id}', () => {
    it('lets a supervisor set it, and takes effect on the column rotation reads', async () => {
      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 9 });

      expect(response.status).toBe(200);
      expect(userOf(response).assignmentCapacity).toEqual({
        maxConcurrentTickets: 9,
        effectiveMaxConcurrentTickets: 9,
        activeTicketCount: 0,
      });

      // The whole of the "no restart, no cache invalidation" criterion: the
      // column the resolver's `coalesce` reads holds the new number the moment
      // the request returns, in this same process, with nothing cleared.
      const row = await systemPrisma.user.findUniqueOrThrow({
        where: { id: AGENT_A },
        select: { maxConcurrentTickets: true },
      });

      expect(row.maxConcurrentTickets).toBe(9);
    });

    it('refuses an agent the write, and leaves the column alone', async () => {
      const response = await call(HOST_A, 'agent')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 9 });

      expect(response.status).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
      expect(
        (
          await systemPrisma.user.findUniqueOrThrow({
            where: { id: AGENT_A },
            select: { maxConcurrentTickets: true },
          })
        ).maxConcurrentTickets,
      ).toBeNull();
    });

    it('clears the override on null, returning the agent to the tenant default', async () => {
      await call(HOST_A, 'supervisor')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 6 });
      await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 9 });

      const cleared = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: null });

      expect(cleared.status).toBe(200);
      expect(userOf(cleared).assignmentCapacity).toEqual({
        maxConcurrentTickets: null,
        effectiveMaxConcurrentTickets: 6,
        activeTicketCount: 0,
      });
    });

    it('refuses a value the CHECK constraint would refuse, as validation_failed', async () => {
      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 1001 });

      // The edge validation is what produces the published error shape; the
      // CHECK is the backstop, and a constraint violation would be a 500.
      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });
  });

  describe('the workload block on GET /users', () => {
    it('shows a supervisor the cap and the live load', async () => {
      await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 4 });
      await assignTicket(AGENT_A);
      await assignTicket(AGENT_A);

      const page = await call(HOST_A, 'supervisor').get('/api/v1/users');
      const agent = usersPageOf(page).items.find((user) => user.id === AGENT_A);

      expect(agent?.assignmentCapacity).toEqual({
        maxConcurrentTickets: 4,
        effectiveMaxConcurrentTickets: 4,
        activeTicketCount: 2,
      });
    });

    it('tells an agent nothing about a colleague, on a route every agent may call', async () => {
      await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ maxConcurrentTickets: 4 });

      const page = await call(HOST_A, 'agent').get('/api/v1/users');

      // Flat cap fields would give anyone in the tenant a live readout of a
      // named colleague's workload and how close they are to being cut off.
      expect(usersPageOf(page).items.every((user) => user.assignmentCapacity === null)).toBe(true);
    });
  });

  describe('nothing crosses the tenant boundary', () => {
    it('keeps two tenants’ defaults apart', async () => {
      await call(HOST_A, 'supervisor')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 11 });
      await call(HOST_B, 'supervisor')
        .patch('/api/v1/assignment-settings')
        .send({ defaultMaxConcurrentTickets: 2 });

      expect(
        settingsOf(await call(HOST_A, 'supervisor').get('/api/v1/assignment-settings'))
          .defaultMaxConcurrentTickets,
      ).toBe(11);
      expect(
        settingsOf(await call(HOST_B, 'supervisor').get('/api/v1/assignment-settings'))
          .defaultMaxConcurrentTickets,
      ).toBe(2);
    });

    it('answers not_found — never forbidden — for another tenant’s user id', async () => {
      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_B}`)
        .send({ maxConcurrentTickets: 1 });

      // A 403 here would confirm the id exists somewhere. RLS returns nothing
      // and the service cannot tell "absent" from "another tenant's".
      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
      expect(
        (
          await systemPrisma.user.findUniqueOrThrow({
            where: { id: AGENT_B },
            select: { maxConcurrentTickets: true },
          })
        ).maxConcurrentTickets,
      ).toBeNull();
    });

    it('counts only the caller tenant’s tickets toward a load', async () => {
      await assignTicket(AGENT_A);

      const response = await call(HOST_B, 'supervisor').get('/api/v1/users');
      const agent = usersPageOf(response).items.find((user) => user.id === AGENT_B);

      expect(
        usersPageOf(response)
          .items.map((user) => user.id)
          .sort(),
      ).toEqual([AGENT_B, SUPERVISOR_B].sort());
      expect(agent?.assignmentCapacity?.activeTicketCount).toBe(0);
    });
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
