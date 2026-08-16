import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CursorPage, TeamResponse, UserResponse } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import type { PrismaClient } from '../generated/prisma/client';

/**
 * TAR-22's three acceptance criteria, end to end against a real PostgreSQL and
 * the real request pipeline — host resolution, principal, permission guard,
 * RLS, all of it.
 *
 * The isolation claim in the acceptance criteria is "no cross-tenant read or
 * write is possible **under any role**", and that is not a claim a unit test can
 * make: it depends on the GUC being set on the same connection as the statement,
 * on the policies TAR-48 wrote, and on composite foreign keys refusing a
 * reference the policy would have allowed. So every mutating case below is run
 * twice — once inside the tenant, once across the boundary — and the boundary
 * case asserts `not_found`, never `forbidden`, because a 403 would confirm the
 * id exists.
 *
 * The role is supplied by the interim stub (`x-dev-role`), which is exactly what
 * TAR-79 specifies and what TAR-83 re-verifies once TAR-35 lands. The stub
 * changes *who* the principal is; every guard, predicate and invariant under
 * test here is the real one.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids and a `tar81-fixture` marker, deleted before the run as
 * well as after, so an interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '81888888-8888-7888-8888-888888888801';
const TENANT_B = '81888888-8888-7888-8888-888888888802';
const HOST_A = 'tar81-a.app.localhost';
const HOST_B = 'tar81-b.app.localhost';

const ADMIN_A = '81888888-8888-7888-8888-8888888888a1';
const SUPERVISOR_A = '81888888-8888-7888-8888-8888888888a2';
const AGENT_A = '81888888-8888-7888-8888-8888888888a3';
const SECOND_ADMIN_A = '81888888-8888-7888-8888-8888888888a4';
const ADMIN_B = '81888888-8888-7888-8888-8888888888b1';
const AGENT_B = '81888888-8888-7888-8888-8888888888b2';
const TEAM_A = '81888888-8888-7888-8888-88888888a001';
const TEAM_B = '81888888-8888-7888-8888-88888888b001';

type Role = 'agent' | 'supervisor' | 'admin';

/**
 * `supertest` types a response body as `any`. These three readers are where
 * that stops, so a test that misreads a field is a compile error rather than an
 * assertion against `undefined` that passes.
 */
const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

const userOf = (response: request.Response): UserResponse => response.body as UserResponse;

const teamOf = (response: request.Response): TeamResponse => response.body as TeamResponse;

const usersPageOf = (response: request.Response): CursorPage<UserResponse> =>
  response.body as CursorPage<UserResponse>;

const idsOf = (response: request.Response): string[] =>
  usersPageOf(response)
    .items.map((user) => user.id)
    .sort();

describe('agent, team and role management API', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;

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
        { id: TENANT_A, slug: 'tar81-fixture-a', name: 'TAR-81 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar81-fixture-b', name: 'TAR-81 fixture B', status: 'active' },
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
          email: 'admin@tar81-a.invalid',
          name: 'A Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'super@tar81-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar81-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: ADMIN_B,
          tenantId: TENANT_B,
          email: 'admin@tar81-b.invalid',
          name: 'B Admin',
          role: 'admin',
          status: 'active',
        },
        {
          id: AGENT_B,
          tenantId: TENANT_B,
          email: 'agent@tar81-b.invalid',
          name: 'B Agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });
    await systemPrisma.team.createMany({
      data: [
        { id: TEAM_A, tenantId: TENANT_A, name: 'Billing' },
        { id: TEAM_B, tenantId: TENANT_B, name: 'Billing' },
      ],
    });
  }

  beforeAll(async () => {
    // The stub is what supplies a role before TAR-35 — and it has to be set
    // before `app.module` is *loaded*, not before the module is compiled:
    // `ConfigModule.forRoot()` is a plain call inside the `@Module` decorator's
    // argument, so it reads and validates the environment the moment the file
    // is imported. Hence the dynamic import below rather than a top-level one.
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
    await systemPrisma.teamMember.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.session.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.invite.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.user.deleteMany({ where: { id: SECOND_ADMIN_A } });
    await systemPrisma.user.deleteMany({
      where: {
        tenantId: TENANT_A,
        email: {
          notIn: ['admin@tar81-a.invalid', 'super@tar81-a.invalid', 'agent@tar81-a.invalid'],
        },
      },
    });
    await systemPrisma.team.deleteMany({ where: { tenantId: TENANT_A, id: { not: TEAM_A } } });
    await systemPrisma.user.update({
      where: { id: AGENT_A },
      data: { role: 'agent', status: 'active', name: 'A Agent' },
    });
    await systemPrisma.user.update({
      where: { id: ADMIN_A },
      data: { role: 'admin', status: 'active' },
    });
  });

  describe('the request needs a tenant before it needs anything else', () => {
    it('answers tenant_not_found for a host no tenant is served at', async () => {
      const response = await call('nobody.app.localhost', 'admin').get('/api/v1/users');

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('tenant_not_found');
    });

    it('answers tenant_not_found for a domain that is not verified yet', async () => {
      // TAR-29's unverified custom domain: the row exists while DNS and TLS are
      // still being proved, and honouring it early would let a customer claim a
      // hostname they have not demonstrated control of.
      //
      // The token is what "still being proved" means — it is the value the
      // customer has to publish in DNS — and TAR-417's
      // `tenant_domains_custom_needs_token` requires every custom row to carry
      // one. Its presence is precisely not what makes a domain verified;
      // `verified_at` is, and it stays null here.
      await systemPrisma.tenantDomain.create({
        data: {
          tenantId: TENANT_A,
          hostname: 'unverified.tar81.localhost',
          kind: 'custom',
          verificationToken: '81818181818181818181818181818181',
        },
      });

      const response = await call('unverified.tar81.localhost', 'admin').get('/api/v1/users');

      expect(response.status).toBe(404);
      await systemPrisma.tenantDomain.deleteMany({
        where: { hostname: 'unverified.tar81.localhost' },
      });
    });
  });

  describe('TAR-22 AC1 — an agent sees no tenant administration', () => {
    it('lets an agent read the people list, because assignee names are rendered from it', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/users');

      expect(response.status).toBe(200);
      expect(idsOf(response)).toEqual([ADMIN_A, SUPERVISOR_A, AGENT_A].sort());
    });

    it.each([
      [
        'invite',
        () =>
          call(HOST_A, 'agent')
            .post('/api/v1/users/invites')
            .send({ email: 'x@tar81-a.invalid', role: 'agent' }),
      ],
      [
        'update',
        () =>
          call(HOST_A, 'agent')
            .patch(`/api/v1/users/${SUPERVISOR_A}`)
            .send({ displayName: 'Hacked' }),
      ],
      ['remove', () => call(HOST_A, 'agent').delete(`/api/v1/users/${SUPERVISOR_A}`)],
      [
        'create a team',
        () => call(HOST_A, 'agent').post('/api/v1/teams').send({ name: 'Agent Team' }),
      ],
    ])('refuses to let an agent %s', async (_label, send) => {
      const response = await send();

      expect(response.status).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
    });

    it('lets an agent set their own availability, which needs no permission', async () => {
      const response = await call(HOST_A, 'agent')
        .patch('/api/v1/users/me/availability')
        .send({ availability: 'away' });

      expect(response.status).toBe(200);
      expect(userOf(response).availability).toBe('away');
      expect(userOf(response).id).toBe(AGENT_A);
    });
  });

  describe('TAR-22 AC3 — a supervisor manages people and teams, tenant-wide', () => {
    it('creates a team and puts an agent in it', async () => {
      const created = await call(HOST_A, 'supervisor')
        .post('/api/v1/teams')
        .send({ name: 'Support', memberUserIds: [AGENT_A] });

      expect(created.status).toBe(201);
      expect(teamOf(created).memberUserIds).toEqual([AGENT_A]);

      // TAR-22 AC2's precondition: the agent's principal now carries the team,
      // which is what makes team-routed conversations visible to them.
      const listed = await call(HOST_A, 'agent').get('/api/v1/users?limit=100');
      const agent = usersPageOf(listed).items.find((user) => user.id === AGENT_A);

      expect(agent?.teamIds).toEqual([teamOf(created).id]);
    });

    it('suspends an agent, and the suspension revokes their sessions immediately', async () => {
      await systemPrisma.session.create({
        data: {
          tenantId: TENANT_A,
          userId: AGENT_A,
          tokenHash: 'tar81-fixture-session',
          expiresAt: new Date(Date.now() + 3_600_000),
          // The 30-day cap the sliding `expiresAt` may not cross (TAR-54).
          // Required, and deliberately so: a session row without one has no
          // outer bound at all.
          absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
        },
      });

      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ status: 'suspended' });

      expect(response.status).toBe(200);
      expect(userOf(response).status).toBe('suspended');
      // ADR 0002's promise that a role or status change takes effect
      // immediately — which the cached principal would otherwise have broken.
      //
      // A revoked row rather than a deleted one since TAR-56: every read path
      // filters `revoked_at IS NULL`, so it grants nothing, and keeping it is
      // what lets the trail say *why* the session died.
      expect(await liveSessionCount(AGENT_A)).toBe(0);
      expect(
        await systemPrisma.session.count({
          where: { userId: AGENT_A, revokedReason: 'status_change' },
        }),
      ).toBe(1);
    });

    it('refuses to let a supervisor assign a role — delta 1', async () => {
      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ role: 'supervisor' });

      expect(response.status).toBe(403);
      // Refused, not silently applied without the role field: a dropped
      // privilege change that appears to succeed is the worse failure.
      expect(await systemPrisma.user.findUnique({ where: { id: AGENT_A } })).toMatchObject({
        role: 'agent',
      });
    });

    it('refuses to let a supervisor invite anybody above an agent', async () => {
      const admin = await call(HOST_A, 'supervisor')
        .post('/api/v1/users/invites')
        .send({ email: 'sneaky@tar81-a.invalid', role: 'admin' });

      expect(admin.status).toBe(403);
      expect(await systemPrisma.user.count({ where: { email: 'sneaky@tar81-a.invalid' } })).toBe(0);
    });

    it('refuses to let a supervisor remove anybody', async () => {
      expect((await call(HOST_A, 'supervisor').delete(`/api/v1/users/${AGENT_A}`)).status).toBe(
        403,
      );
    });
  });

  describe('an admin holds the whole tenant scope', () => {
    it('invites an agent, reserving the account and parking its teams', async () => {
      const response = await call(HOST_A, 'admin')
        .post('/api/v1/users/invites')
        .send({ email: 'newhire@tar81-a.invalid', role: 'agent', teamIds: [TEAM_A] });

      expect(response.status).toBe(201);

      const invited = await systemPrisma.user.findFirst({
        where: { tenantId: TENANT_A, email: 'newhire@tar81-a.invalid' },
        select: { status: true, passwordHash: true, teamMemberships: { select: { teamId: true } } },
      });

      expect(invited).toMatchObject({ status: 'invited', passwordHash: null });
      // The teams wait on `invite_teams` until the invitation is accepted
      // (TAR-55), so somebody who never accepts never widens a team's
      // membership — and therefore never widens what its members can see.
      expect(invited?.teamMemberships).toEqual([]);
      expect(
        await systemPrisma.inviteTeam.count({ where: { tenantId: TENANT_A, teamId: TEAM_A } }),
      ).toBe(1);
    });

    it('stores only a hash of the invite token, never the token', async () => {
      await call(HOST_A, 'admin')
        .post('/api/v1/users/invites')
        .send({ email: 'hashed@tar81-a.invalid', role: 'agent' });

      const invite = await systemPrisma.invite.findFirst({
        where: { email: 'hashed@tar81-a.invalid' },
        select: { tokenHash: true },
      });

      // SHA-256 hex. A token would be base64url and a different length.
      expect(invite?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('promotes an agent, audits it, and logs them out', async () => {
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ role: 'supervisor' });

      expect(response.status).toBe(200);
      expect(userOf(response).role).toBe('supervisor');

      const audits = await systemPrisma.auditLog.findMany({
        where: { tenantId: TENANT_A, targetId: AGENT_A },
        select: { action: true, actorUserId: true, metadata: true },
      });

      expect(audits).toContainEqual({
        action: 'user.role_changed',
        actorUserId: ADMIN_A,
        metadata: { from: 'agent', to: 'supervisor' },
      });
    });

    it('refuses to let an admin change their own role — invariant 1', async () => {
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${ADMIN_A}`)
        .send({ role: 'agent' });

      expect(response.status).toBe(403);
    });

    it('removes a user as a soft delete: delisted, logged out, seat freed', async () => {
      const response = await call(HOST_A, 'admin').delete(`/api/v1/users/${AGENT_A}`);

      expect(response.status).toBe(204);
      expect(await systemPrisma.user.findUnique({ where: { id: AGENT_A } })).toMatchObject({
        status: 'removed',
      });

      const listed = await call(HOST_A, 'admin').get('/api/v1/users?limit=100');

      expect(usersPageOf(listed).items.map((user) => user.id)).not.toContain(AGENT_A);
    });

    it('is idempotent on a repeated remove', async () => {
      await call(HOST_A, 'admin').delete(`/api/v1/users/${AGENT_A}`);
      const second = await call(HOST_A, 'admin').delete(`/api/v1/users/${AGENT_A}`);

      expect(second.status).toBe(204);
      expect(
        await systemPrisma.auditLog.count({
          where: { targetId: AGENT_A, action: 'user.removed' },
        }),
      ).toBe(1);
    });
  });

  describe('invariant 3 — the last active admin', () => {
    it('cannot be suspended or removed, even by themselves', async () => {
      // The stub resolves the lowest-id active admin, so ADMIN_A is both the
      // caller and the target here — which is the case that actually strands a
      // tenant in practice: the last admin tidying up their own account.
      for (const [label, send] of [
        [
          'suspend',
          () =>
            call(HOST_A, 'admin').patch(`/api/v1/users/${ADMIN_A}`).send({ status: 'suspended' }),
        ],
        ['remove', () => call(HOST_A, 'admin').delete(`/api/v1/users/${ADMIN_A}`)],
      ] as const) {
        const response = await send();

        expect({ label, status: response.status }).toEqual({ label, status: 409 });
        expect(errorCodeOf(response)).toBe('last_admin_required');
      }

      expect(await systemPrisma.user.findUnique({ where: { id: ADMIN_A } })).toMatchObject({
        role: 'admin',
        status: 'active',
      });
    });

    it('is refused a self-demotion by invariant 1 first, which is the truer reason', async () => {
      // Ordering, stated rather than incidental: invariant 1 runs before the
      // locking read, so the caller is told "you cannot change your own role"
      // rather than "you are the last admin". Both are true; the first is the
      // one they can act on, and it costs no database round trip.
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${ADMIN_A}`)
        .send({ role: 'supervisor' });

      expect(response.status).toBe(403);
    });

    it('can be demoted once a second admin exists', async () => {
      await systemPrisma.user.create({
        data: {
          id: SECOND_ADMIN_A,
          tenantId: TENANT_A,
          email: 'admin2@tar81-a.invalid',
          name: 'A Second Admin',
          role: 'admin',
          status: 'active',
        },
      });

      // The stub resolves the lowest-id admin, which is ADMIN_A, so this is the
      // second admin being demoted by the first.
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${SECOND_ADMIN_A}`)
        .send({ role: 'supervisor' });

      expect(response.status).toBe(200);
    });
  });

  describe('tenant isolation — no role reaches across the boundary', () => {
    it('shows each host only its own tenant’s people', async () => {
      const fromB = await call(HOST_B, 'admin').get('/api/v1/users?limit=100');

      expect(idsOf(fromB)).toEqual([ADMIN_B, AGENT_B].sort());
    });

    it.each([
      [
        'read another tenant’s team',
        () => call(HOST_A, 'admin').patch(`/api/v1/teams/${TEAM_B}`).send({ name: 'Stolen' }),
      ],
      [
        'promote another tenant’s agent',
        () => call(HOST_A, 'admin').patch(`/api/v1/users/${AGENT_B}`).send({ role: 'admin' }),
      ],
      [
        'suspend another tenant’s agent',
        () => call(HOST_A, 'admin').patch(`/api/v1/users/${AGENT_B}`).send({ status: 'suspended' }),
      ],
      [
        'remove another tenant’s agent',
        () => call(HOST_A, 'admin').delete(`/api/v1/users/${AGENT_B}`),
      ],
    ])('answers not_found — never forbidden — when an admin tries to %s', async (_label, send) => {
      const response = await send();

      // 404 rather than 403: a 403 would confirm the id exists somewhere.
      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });

    it('leaves the other tenant’s rows untouched after every attempt', async () => {
      expect(await systemPrisma.user.findUnique({ where: { id: AGENT_B } })).toMatchObject({
        role: 'agent',
        status: 'active',
      });
      expect(await systemPrisma.team.findUnique({ where: { id: TEAM_B } })).toMatchObject({
        name: 'Billing',
      });
    });

    it('refuses to put another tenant’s user in its own team', async () => {
      const response = await call(HOST_A, 'supervisor')
        .post('/api/v1/teams')
        .send({ name: 'Cross Tenant', memberUserIds: [AGENT_B] });

      // Rejected at validation, naming the id — the composite foreign key would
      // have refused it anyway, but as a 500 rather than something actionable.
      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
      expect(await systemPrisma.teamMember.count({ where: { userId: AGENT_B } })).toBe(0);
    });

    it('refuses to put its own user in another tenant’s team', async () => {
      const response = await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ teamIds: [TEAM_B] });

      expect(response.status).toBe(400);
      expect(await systemPrisma.teamMember.count({ where: { teamId: TEAM_B } })).toBe(0);
    });

    it('lets both tenants hold a team of the same name', async () => {
      const response = await call(HOST_B, 'admin').post('/api/v1/teams').send({ name: 'Support' });

      expect(response.status).toBe(201);
      await systemPrisma.team.deleteMany({ where: { tenantId: TENANT_B, name: 'Support' } });
    });
  });

  describe('TAR-59 — a lockout is visible to whoever may clear it', () => {
    const lockedUntil = new Date(Date.now() + 15 * 60 * 1000);

    /**
     * Written straight to the columns: what *causes* a lockout is TAR-56's
     * login flow, covered in `session-lifecycle.int-spec.ts`. `status` comes
     * back with it because an earlier case in this file removes the agent, and
     * a block that depends on where the one above it left the fixture is a
     * block that fails when somebody reorders them.
     */
    async function lockAgentA(): Promise<void> {
      await systemPrisma.user.update({
        where: { id: AGENT_A },
        data: { lockedUntil, failedLoginAttempts: 10, status: 'active' },
      });
    }

    beforeEach(lockAgentA);

    it('shows an admin the lockout on the people list', async () => {
      const response = await call(HOST_A, 'admin').get('/api/v1/users?limit=100');

      expect(usersPageOf(response).items.find((user) => user.id === AGENT_A)?.security).toEqual({
        lockedUntil: lockedUntil.toISOString(),
        failedLoginAttempts: 10,
      });
    });

    it('tells an agent nothing, though the same route serves them', async () => {
      const response = await call(HOST_A, 'agent').get('/api/v1/users?limit=100');

      // `user:read` is an agent permission. Without the gate, every agent could
      // watch a named colleague's failed attempts climb.
      expect(usersPageOf(response).items.every((user) => user.security === null)).toBe(true);
    });

    it('refuses to let an agent unlock anybody', async () => {
      const response = await call(HOST_A, 'agent').post(`/api/v1/users/${AGENT_A}/unlock`);

      expect(response.status).toBe(403);
      expect(errorCodeOf(response)).toBe('forbidden');
    });

    it('lets an admin clear it, and answers with the cleared state', async () => {
      const response = await call(HOST_A, 'admin').post(`/api/v1/users/${AGENT_A}/unlock`);

      expect(response.status).toBe(200);
      expect(userOf(response).security).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });
      expect(
        await systemPrisma.user.findUnique({
          where: { id: AGENT_A },
          select: { lockedUntil: true, failedLoginAttempts: true },
        }),
      ).toEqual({ lockedUntil: null, failedLoginAttempts: 0 });
    });

    it('lets a supervisor clear it too, because they may administer the same people', async () => {
      const response = await call(HOST_A, 'supervisor').post(`/api/v1/users/${AGENT_A}/unlock`);

      expect(response.status).toBe(200);
    });

    it('is a no-op the second time, and audits only the first', async () => {
      await call(HOST_A, 'admin').post(`/api/v1/users/${AGENT_A}/unlock`);
      const second = await call(HOST_A, 'admin').post(`/api/v1/users/${AGENT_A}/unlock`);

      expect(second.status).toBe(200);
      expect(
        await systemPrisma.auditLog.count({
          where: { tenantId: TENANT_A, targetId: AGENT_A, action: 'auth.unlock' },
        }),
      ).toBe(1);
    });

    it('answers not_found for another tenant’s locked account', async () => {
      await systemPrisma.user.update({
        where: { id: AGENT_B },
        data: { lockedUntil, failedLoginAttempts: 10 },
      });

      const response = await call(HOST_A, 'admin').post(`/api/v1/users/${AGENT_B}/unlock`);

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
      // And genuinely untouched: a 404 that still wrote would be worse than a 200.
      expect(
        await systemPrisma.user.findUnique({
          where: { id: AGENT_B },
          select: { failedLoginAttempts: true },
        }),
      ).toEqual({ failedLoginAttempts: 10 });
    });
  });

  describe('teams', () => {
    it('rejects a second team whose name differs only by case', async () => {
      const response = await call(HOST_A, 'supervisor')
        .post('/api/v1/teams')
        .send({ name: 'billing' });

      expect(response.status).toBe(409);
      expect(errorCodeOf(response)).toBe('conflict');
    });

    it('replaces a membership and logs out everybody who moved', async () => {
      await call(HOST_A, 'admin')
        .patch(`/api/v1/users/${AGENT_A}`)
        .send({ teamIds: [TEAM_A] });
      await systemPrisma.session.create({
        data: {
          tenantId: TENANT_A,
          userId: AGENT_A,
          tokenHash: 'tar81-fixture-session-team',
          expiresAt: new Date(Date.now() + 3_600_000),
          absoluteExpiresAt: new Date(Date.now() + 30 * 24 * 3_600_000),
        },
      });

      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/teams/${TEAM_A}`)
        .send({ memberUserIds: [SUPERVISOR_A] });

      expect(response.status).toBe(200);
      expect(teamOf(response).memberUserIds).toEqual([SUPERVISOR_A]);
      // The removed member keeps the team's visibility until their session
      // dies, so the session has to die with the membership.
      expect(await liveSessionCount(AGENT_A)).toBe(0);
    });

    it('lets every role read the team list, because agents see routing labels', async () => {
      for (const role of ['agent', 'supervisor', 'admin'] as const) {
        const response = await call(HOST_A, role).get('/api/v1/teams');

        expect({ role, status: response.status }).toEqual({ role, status: 200 });
      }
    });
  });

  /**
   * Sessions the user could still authenticate with.
   *
   * Revocation is a soft one since TAR-56 — `revoked_at` plus a reason, so the
   * audit trail can say why — and every read path filters on it. Counting rows
   * would therefore be counting history, not access.
   */
  async function liveSessionCount(userId: string): Promise<number> {
    return await systemPrisma.session.count({ where: { userId, revokedAt: null } });
  }
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
