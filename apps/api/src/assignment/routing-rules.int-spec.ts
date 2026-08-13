import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  TICKET_ROUTER,
  type AssignmentRuleListResponse,
  type AssignmentRuleResponse,
  type TicketRouter,
  type TicketRoutingResult,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * TAR-288's fourth acceptance criterion — **no rule, condition or routing
 * decision leaks across tenants** — plus the CRUD and evaluation paths end to
 * end against a real PostgreSQL and the real request pipeline.
 *
 * Isolation is not a claim a unit test can make. It depends on the GUC being set
 * on the same connection as the statement, on the policies TAR-48 wrote, and on
 * composite foreign keys refusing a reference the policy would have allowed —
 * none of which a fake has. So every case below is run against two tenants whose
 * fixtures are deliberately identical in shape: both have a `Billing` team, both
 * have a rule named `Billing keywords`, and both have a ticket opened by a
 * message saying "invoice". If any part of the routing surface leaked, these two
 * would be indistinguishable and the assertions would pass by accident — so the
 * ids differ and the assertions name them.
 *
 * The two axes are the host (which tenant) and the role (which permission), the
 * same pair `people-rbac.int-spec.ts` varies. The role comes from the interim
 * stub, which changes *who* the principal is; every guard, policy and predicate
 * under test is the real one.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after, so an interrupted
 * run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '88888888-0000-7000-8000-000000000001';
const TENANT_B = '88888888-0000-7000-8000-000000000002';
const HOST_A = 'tar288-a.app.localhost';
const HOST_B = 'tar288-b.app.localhost';

const SUPERVISOR_A = '88888888-0000-7000-8000-0000000000a1';
const SARA_A = '88888888-0000-7000-8000-0000000000a2';
const SUSPENDED_A = '88888888-0000-7000-8000-0000000000a3';
const SUPERVISOR_B = '88888888-0000-7000-8000-0000000000b1';

const BILLING_TEAM_A = '88888888-0000-7000-8000-0000000001a1';
const EMPTY_TEAM_A = '88888888-0000-7000-8000-0000000001a2';
const BILLING_TEAM_B = '88888888-0000-7000-8000-0000000001b1';

const CONTACT_A = '88888888-0000-7000-8000-0000000002a1';
const CONTACT_B = '88888888-0000-7000-8000-0000000002b1';
const VIP_TAG_A = '88888888-0000-7000-8000-0000000003a1';
const TICKET_A = '88888888-0000-7000-8000-0000000004a1';
const TICKET_B = '88888888-0000-7000-8000-0000000004b1';
const MESSAGE_A = '88888888-0000-7000-8000-0000000005a1';
const MESSAGE_B = '88888888-0000-7000-8000-0000000005b1';

const WABA_A = '88888888-0000-7000-8000-0000000006a1';
const WABA_B = '88888888-0000-7000-8000-0000000006b1';
const NUMBER_A = '88888888-0000-7000-8000-0000000007a1';
const NUMBER_B = '88888888-0000-7000-8000-0000000007b1';
const CONVERSATION_A = '88888888-0000-7000-8000-0000000008a1';
const CONVERSATION_B = '88888888-0000-7000-8000-0000000008b1';

type Role = 'agent' | 'supervisor' | 'admin';

/** `supertest` types a body as `any`. These readers are where that stops. */
const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

const ruleOf = (response: request.Response): AssignmentRuleResponse =>
  response.body as AssignmentRuleResponse;

const listOf = (response: request.Response): AssignmentRuleListResponse =>
  response.body as AssignmentRuleListResponse;

const BILLING_KEYWORDS = [
  { type: 'keyword', match: 'any', values: ['invoice', 'billing'] },
] as const;

describe('routing rules and the evaluation engine', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;
  let router: TicketRouter;
  let tenantContext: TenantContextService;

  /** One request as `role`, at `host`. The two axes every case below varies. */
  function call(host: string, role: Role) {
    return request
      .agent(app.getHttpServer() as Server)
      .set('Host', host)
      .set('x-dev-role', role);
  }

  /**
   * Routes a ticket the way the queue runner would: in a tenant scope opened
   * from the payload's `tenantId`, which is the only thing that makes
   * `TenantPrisma` — and therefore RLS — resolve at all.
   */
  async function route(
    tenantId: string,
    ticketId: string,
    messageId: string | null,
    contactId: string | null,
  ): Promise<TicketRoutingResult> {
    return await tenantContext.run(
      { requestId: `int-spec:${ticketId}`, tenantId, userId: null },
      async () =>
        await router.routeTicket({
          tenantId,
          ticketId,
          contactId,
          messageId,
          createdAt: new Date('2026-08-10T10:00:00.000Z').toISOString(),
        }),
    );
  }

  async function createRule(
    host: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return await call(host, 'supervisor').post('/api/v1/assignment-rules').send(body);
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar288-fixture-a', name: 'TAR-288 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar288-fixture-b', name: 'TAR-288 fixture B', status: 'active' },
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
        {
          tenantId: TENANT_A,
          timezone: 'Europe/London',
          businessHours: { mon: [{ from: '09:00', to: '17:00' }] },
        },
        { tenantId: TENANT_B, timezone: 'Europe/London' },
      ],
    });
    await systemPrisma.user.createMany({
      data: [
        {
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'super@tar288-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: SARA_A,
          tenantId: TENANT_A,
          email: 'sara@tar288-a.invalid',
          name: 'Sara',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUSPENDED_A,
          tenantId: TENANT_A,
          email: 'gone@tar288-a.invalid',
          name: 'Suspended Sam',
          role: 'agent',
          status: 'suspended',
        },
        {
          id: SUPERVISOR_B,
          tenantId: TENANT_B,
          email: 'super@tar288-b.invalid',
          name: 'B Supervisor',
          role: 'supervisor',
          status: 'active',
        },
      ],
    });
    await systemPrisma.team.createMany({
      data: [
        { id: BILLING_TEAM_A, tenantId: TENANT_A, name: 'Billing' },
        { id: EMPTY_TEAM_A, tenantId: TENANT_A, name: 'Nobody' },
        // Same name, other tenant. If any read leaked, the two would be
        // indistinguishable — which is why the assertions name the ids.
        { id: BILLING_TEAM_B, tenantId: TENANT_B, name: 'Billing' },
      ],
    });
    await systemPrisma.teamMember.createMany({
      data: [
        { tenantId: TENANT_A, teamId: BILLING_TEAM_A, userId: SARA_A },
        { tenantId: TENANT_B, teamId: BILLING_TEAM_B, userId: SUPERVISOR_B },
      ],
    });
    await systemPrisma.customFieldDef.createMany({
      data: [
        { tenantId: TENANT_A, key: 'plan', label: 'Plan' },
        { tenantId: TENANT_B, key: 'plan', label: 'Plan' },
      ],
    });
    await systemPrisma.tag.createMany({
      data: [{ id: VIP_TAG_A, tenantId: TENANT_A, name: 'VIP' }],
    });
    await systemPrisma.contact.createMany({
      data: [
        {
          id: CONTACT_A,
          tenantId: TENANT_A,
          phoneE164: '+10000028801',
          customFields: { plan: 'gold' },
        },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000028802' },
      ],
    });
    await systemPrisma.contactTag.createMany({
      data: [{ tenantId: TENANT_A, contactId: CONTACT_A, tagId: VIP_TAG_A }],
    });
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar288-waba-a' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar288-waba-b' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: NUMBER_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar288-number-a',
          displayPhoneNumber: '+10000028801',
        },
        {
          id: NUMBER_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar288-number-b',
          displayPhoneNumber: '+10000028802',
        },
      ],
    });
    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: NUMBER_A,
          contactId: CONTACT_A,
        },
        {
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: NUMBER_B,
          contactId: CONTACT_B,
        },
      ],
    });
    await systemPrisma.message.createMany({
      data: [
        {
          id: MESSAGE_A,
          tenantId: TENANT_A,
          conversationId: CONVERSATION_A,
          direction: 'inbound',
          status: 'delivered',
          body: 'where is my invoice',
          sentAt: new Date('2026-08-10T10:00:00.000Z'),
        },
        {
          id: MESSAGE_B,
          tenantId: TENANT_B,
          conversationId: CONVERSATION_B,
          direction: 'inbound',
          status: 'delivered',
          body: 'where is my invoice',
          sentAt: new Date('2026-08-10T10:00:00.000Z'),
        },
      ],
    });
  }

  /** Both tenants' tickets, back to unassigned and open. */
  async function resetTickets(): Promise<void> {
    await systemPrisma.ticketEvent.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.ticket.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.ticket.createMany({
      data: [
        {
          id: TICKET_A,
          tenantId: TENANT_A,
          number: 1,
          conversationId: CONVERSATION_A,
          contactId: CONTACT_A,
          status: 'open',
        },
        {
          id: TICKET_B,
          tenantId: TENANT_B,
          number: 1,
          conversationId: CONVERSATION_B,
          contactId: CONTACT_B,
          status: 'open',
        },
      ],
    });
  }

  beforeAll(async () => {
    // The stub is what supplies a role before TAR-35, and it has to be set
    // before `app.module` is *loaded* — `ConfigModule.forRoot()` reads the
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
    await app.init();

    router = app.get<TicketRouter>(TICKET_ROUTER);
    tenantContext = app.get(TenantContextService);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Each test starts from the seeded shape, so they pass in any order.
    await systemPrisma.assignmentRule.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await resetTickets();
    await makeNobodyAvailable();
  });

  /**
   * Puts every agent out of rotation's reach, explicitly.
   *
   * Since TAR-23 landed, `FALLBACK_ASSIGNMENT_RESOLVER` is bound to the real
   * `RotationFallbackResolver` rather than a stub, so "no rule matched" no longer
   * implies "deferred" — it implies whatever rotation decides. Rotation's
   * candidate predicate wants `availability = 'available'` **and** a `last_seen_at`
   * inside the presence window, and a freshly seeded user satisfies neither.
   *
   * That means the deferred cases below would pass without this call — and pass
   * for the wrong reason, resting on an unset column rather than on anything the
   * test says. Arranging it out loud is what keeps them honest, and what makes
   * `makeAvailable` below the single visible difference in the case that expects
   * rotation to place the ticket.
   */
  async function makeNobodyAvailable(): Promise<void> {
    await systemPrisma.user.updateMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
      data: { availability: 'offline', lastSeenAt: null },
    });
  }

  /** One agent rotation will consider: active, available, and seen just now. */
  async function makeAvailable(userId: string): Promise<void> {
    await systemPrisma.user.update({
      where: { id: userId },
      data: { availability: 'available', lastSeenAt: new Date() },
    });
  }

  describe('the CRUD surface', () => {
    it('creates a rule and returns it in the published shape', async () => {
      const response = await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect(response.status).toBe(201);
      expect(ruleOf(response)).toMatchObject({
        name: 'Billing keywords',
        position: 0,
        isActive: true,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });
    });

    it('audits the write, because a rule is a standing instruction about customer data', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      const audited = await systemPrisma.auditLog.findMany({ where: { tenantId: TENANT_A } });

      expect(audited.map((row) => row.action)).toEqual(['assignment_rule.created']);
    });

    it('refuses a duplicate name case-insensitively, because `name` is citext', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      const clash = await createRule(HOST_A, {
        name: 'BILLING KEYWORDS',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect(clash.status).toBe(409);
      expect(errorCodeOf(clash)).toBe('conflict');
    });

    it('refuses an empty condition list', async () => {
      // A rule matching everything, placed anywhere but last, silently swallows
      // all routing — and the thing it would express is already the fallback.
      const response = await createRule(HOST_A, {
        name: 'Everything',
        conditions: [],
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('cannot be made to name both a team and a user', async () => {
      // "Exactly one target" is enforced by the shape rather than by a check:
      // `RoutingTargetSchema` is a discriminated union, and the pipe strips
      // unknown keys (TAR-39, conventions), so a client sending both gets the
      // one its `kind` named and the other is dropped before any code sees it.
      // The stronger property than a 400 — there is no "both" to refuse.
      const response = await createRule(HOST_A, {
        name: 'Both',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A, userId: SARA_A },
      });

      expect(response.status).toBe(201);
      expect(ruleOf(response).target).toEqual({ kind: 'team', teamId: BILLING_TEAM_A });

      const stored = await systemPrisma.assignmentRule.findUniqueOrThrow({
        where: { id: ruleOf(response).id },
        select: { targetTeamId: true, targetUserId: true },
      });

      expect(stored).toEqual({ targetTeamId: BILLING_TEAM_A, targetUserId: null });
    });

    it('refuses a target that names no kind at all', async () => {
      const response = await createRule(HOST_A, {
        name: 'Nowhere',
        conditions: BILLING_KEYWORDS,
        target: { teamId: BILLING_TEAM_A },
      });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('lists in evaluation order, not creation order', async () => {
      await createRule(HOST_A, {
        name: 'Second',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        position: 5,
      });
      await createRule(HOST_A, {
        name: 'First',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        position: 1,
      });

      const response = await call(HOST_A, 'supervisor').get('/api/v1/assignment-rules');

      expect(listOf(response).items.map((rule) => rule.name)).toEqual(['First', 'Second']);
      // Bounded by `rulesPerTenant`, so the cursor is always null and the shape
      // still fits a generic list client.
      expect(listOf(response).nextCursor).toBeNull();
    });

    it('reorders the whole set, and refuses a set that is not the current one', async () => {
      const first = ruleOf(
        await createRule(HOST_A, {
          name: 'First',
          conditions: BILLING_KEYWORDS,
          target: { kind: 'team', teamId: BILLING_TEAM_A },
        }),
      );
      const second = ruleOf(
        await createRule(HOST_A, {
          name: 'Second',
          conditions: BILLING_KEYWORDS,
          target: { kind: 'team', teamId: BILLING_TEAM_A },
        }),
      );

      const reordered = await call(HOST_A, 'supervisor')
        .post('/api/v1/assignment-rules/reorder')
        .send({ ruleIds: [second.id, first.id] });

      expect(reordered.status).toBe(200);
      expect(listOf(reordered).items.map((rule) => rule.name)).toEqual(['Second', 'First']);

      const stale = await call(HOST_A, 'supervisor')
        .post('/api/v1/assignment-rules/reorder')
        .send({ ruleIds: [second.id] });

      expect(stale.status).toBe(409);
    });

    it('deletes idempotently', async () => {
      const rule = ruleOf(
        await createRule(HOST_A, {
          name: 'Doomed',
          conditions: BILLING_KEYWORDS,
          target: { kind: 'team', teamId: BILLING_TEAM_A },
        }),
      );

      const first = await call(HOST_A, 'supervisor').delete(`/api/v1/assignment-rules/${rule.id}`);
      const again = await call(HOST_A, 'supervisor').delete(`/api/v1/assignment-rules/${rule.id}`);

      expect(first.status).toBe(204);
      expect(again.status).toBe(204);
    });

    it('refuses to enable a rule whose target user was removed', async () => {
      // The state `UsersService` deliberately leaves behind, and the reason the
      // CHECK constraint is conditional on `is_active`. The API completes it:
      // the supervisor is told what is missing rather than shown a constraint
      // violation.
      const rule = await systemPrisma.assignmentRule.create({
        data: {
          tenantId: TENANT_A,
          name: 'Orphaned',
          conditions: [...BILLING_KEYWORDS],
          isActive: false,
        },
        select: { id: true },
      });

      const response = await call(HOST_A, 'supervisor')
        .patch(`/api/v1/assignment-rules/${rule.id}`)
        .send({ isActive: true });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });
  });

  describe('permissions', () => {
    it('lets an agent neither read nor write routing rules', async () => {
      // `assignment_rule:*` is granted to supervisor and admin (0004). An agent
      // holds neither half.
      const read = await call(HOST_A, 'agent').get('/api/v1/assignment-rules');
      const write = await createRule(HOST_A, {
        name: 'Sneaky',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect(read.status).toBe(403);
      expect(errorCodeOf(read)).toBe('forbidden');
      expect(await call(HOST_A, 'agent').post('/api/v1/assignment-rules').send({})).toMatchObject({
        status: 403,
      });
      // The supervisor's own create still works, so the 403 above is the
      // permission and not a broken fixture.
      expect(write.status).toBe(201);
    });
  });

  describe('tenant isolation', () => {
    it('shows each tenant only its own rules', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });
      await createRule(HOST_B, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_B },
      });

      const listA = listOf(await call(HOST_A, 'supervisor').get('/api/v1/assignment-rules'));
      const listB = listOf(await call(HOST_B, 'supervisor').get('/api/v1/assignment-rules'));

      // Same name in both, different target — so a leak would be visible as the
      // wrong team id rather than as an extra row.
      expect(listA.items).toHaveLength(1);
      expect(listA.items[0]?.target).toEqual({ kind: 'team', teamId: BILLING_TEAM_A });
      expect(listB.items).toHaveLength(1);
      expect(listB.items[0]?.target).toEqual({ kind: 'team', teamId: BILLING_TEAM_B });
    });

    it('answers not_found — never forbidden — for another tenant’s rule', async () => {
      const rule = ruleOf(
        await createRule(HOST_A, {
          name: 'A only',
          conditions: BILLING_KEYWORDS,
          target: { kind: 'team', teamId: BILLING_TEAM_A },
        }),
      );

      // A 403 here would confirm the id exists somewhere, which is exactly what
      // 0004 refuses to do.
      const read = await call(HOST_B, 'supervisor').get(`/api/v1/assignment-rules/${rule.id}`);
      const write = await call(HOST_B, 'supervisor')
        .patch(`/api/v1/assignment-rules/${rule.id}`)
        .send({ name: 'Stolen' });

      expect(read.status).toBe(404);
      expect(errorCodeOf(read)).toBe('not_found');
      expect(write.status).toBe(404);
      expect(errorCodeOf(write)).toBe('not_found');
    });

    it('refuses to delete another tenant’s rule, and leaves it standing', async () => {
      const rule = ruleOf(
        await createRule(HOST_A, {
          name: 'A only',
          conditions: BILLING_KEYWORDS,
          target: { kind: 'team', teamId: BILLING_TEAM_A },
        }),
      );

      // Delete is idempotent, so it answers 204 either way — the assertion that
      // matters is that the row survived.
      await call(HOST_B, 'supervisor').delete(`/api/v1/assignment-rules/${rule.id}`);

      expect(
        await systemPrisma.assignmentRule.findUnique({ where: { id: rule.id } }),
      ).not.toBeNull();
    });

    it('refuses a rule targeting another tenant’s team, as validation and not not_found', async () => {
      const response = await createRule(HOST_A, {
        name: 'Cross-tenant',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_B },
      });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('routes each tenant’s ticket by its own rules only', async () => {
      // Both tenants have a rule with the same name matching the same word
      // against a ticket opened by the same message text. The only thing that
      // can tell them apart is the tenant boundary.
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });
      await createRule(HOST_B, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_B },
      });

      const resultA = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);
      const resultB = await route(TENANT_B, TICKET_B, MESSAGE_B, CONTACT_B);

      expect(resultA.assignedTeamId).toBe(BILLING_TEAM_A);
      expect(resultB.assignedTeamId).toBe(BILLING_TEAM_B);
    });

    it('does not let one tenant’s rule reach another tenant’s ticket', async () => {
      // Only A has a rule. B's identical ticket must fall through to rotation.
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      const resultB = await route(TENANT_B, TICKET_B, MESSAGE_B, CONTACT_B);

      expect(resultB.outcome).toBe('deferred');
      expect(resultB.assignedTeamId).toBeNull();

      const ticketB = await systemPrisma.ticket.findUniqueOrThrow({ where: { id: TICKET_B } });

      expect(ticketB.assignedTeamId).toBeNull();
      expect(ticketB.assignedUserId).toBeNull();
    });

    it('refuses to route a ticket named by a payload from another tenant', async () => {
      // A forged or stale job. The read finds nothing under RLS and the job
      // fails loudly rather than routing one tenant's ticket in another's scope.
      await expect(route(TENANT_B, TICKET_A, MESSAGE_A, CONTACT_A)).rejects.toThrow();
    });
  });

  describe('evaluating against real rows', () => {
    it('routes on a keyword in the message that opened the ticket', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      const result = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      expect(result).toMatchObject({ outcome: 'routed', assignedTeamId: BILLING_TEAM_A });

      const ticket = await systemPrisma.ticket.findUniqueOrThrow({ where: { id: TICKET_A } });

      expect(ticket.assignedTeamId).toBe(BILLING_TEAM_A);
      expect(ticket.assignedUserId).toBeNull();
    });

    it('writes an `assigned` event naming the rule, with no actor', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      const [event] = await systemPrisma.ticketEvent.findMany({ where: { ticketId: TICKET_A } });

      expect(event?.type).toBe('assigned');
      // Null actor: `ticket_events.actor_user_id` already documents null as
      // "the actor is the system".
      expect(event?.actorUserId).toBeNull();
      expect(event?.data).toMatchObject({ reason: 'Routed by rule "Billing keywords"' });
    });

    it('takes the first match when several rules match', async () => {
      await createRule(HOST_A, {
        name: 'Second by position',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'user', userId: SARA_A },
        position: 5,
      });
      await createRule(HOST_A, {
        name: 'First by position',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        position: 1,
      });

      const result = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      expect(result.assignedTeamId).toBe(BILLING_TEAM_A);
      expect(result.assignedUserId).toBeNull();
    });

    it('skips a matching rule whose team has no active members', async () => {
      await createRule(HOST_A, {
        name: 'Empty team first',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: EMPTY_TEAM_A },
        position: 1,
      });
      await createRule(HOST_A, {
        name: 'Billing second',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        position: 2,
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).assignedTeamId).toBe(
        BILLING_TEAM_A,
      );
    });

    it('skips a matching rule whose target user is suspended', async () => {
      await createRule(HOST_A, {
        name: 'To a suspended agent',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'user', userId: SUSPENDED_A },
        position: 1,
      });
      await createRule(HOST_A, {
        name: 'Billing second',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        position: 2,
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).assignedTeamId).toBe(
        BILLING_TEAM_A,
      );
    });

    it('ignores a disabled rule', async () => {
      await createRule(HOST_A, {
        name: 'Disabled',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
        isActive: false,
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).outcome).toBe('deferred');
    });

    it('routes on a tag the contact carries', async () => {
      await createRule(HOST_A, {
        name: 'VIPs',
        conditions: [{ type: 'tag', match: 'any', tagIds: [VIP_TAG_A] }],
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).outcome).toBe('routed');
    });

    it('routes on a contact custom field', async () => {
      await createRule(HOST_A, {
        name: 'Gold plan',
        conditions: [{ type: 'contact_attribute', key: 'plan', operator: 'equals', value: 'gold' }],
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).outcome).toBe('routed');
    });

    it('routes on business hours, read from the tenant’s own timezone', async () => {
      // The fixture opens Monday 09:00–17:00 in Europe/London, and the ticket
      // is routed against its own `created_at`.
      await systemPrisma.ticket.update({
        where: { id: TICKET_A },
        // Monday 2026-08-10, 11:00 BST.
        data: { createdAt: new Date('2026-08-10T10:00:00.000Z') },
      });
      await createRule(HOST_A, {
        name: 'Open hours',
        conditions: [{ type: 'business_hours', within: true }],
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).outcome).toBe('routed');
    });

    it('matches no business-hours rule at all for a tenant that configured none', async () => {
      // Tenant B has no `business_hours`. 0007 decision 3: false either way, so
      // "out of hours, route to on-call" does not fire on every ticket.
      await createRule(HOST_B, {
        name: 'Out of hours',
        conditions: [{ type: 'business_hours', within: false }],
        target: { kind: 'team', teamId: BILLING_TEAM_B },
      });

      expect((await route(TENANT_B, TICKET_B, MESSAGE_B, CONTACT_B)).outcome).toBe('deferred');
    });

    it('is idempotent: a redelivered job finds the ticket assigned and skips', async () => {
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      const first = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);
      const second = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      expect(first.outcome).toBe('routed');
      expect(second).toMatchObject({ outcome: 'skipped', reason: 'already_assigned' });
      // And exactly one event, so the log never claims two assignments.
      expect(await systemPrisma.ticketEvent.count({ where: { ticketId: TICKET_A } })).toBe(1);
    });

    it('leaves a manual assignment alone', async () => {
      await systemPrisma.ticket.update({
        where: { id: TICKET_A },
        data: { assignedUserId: SARA_A },
      });
      await createRule(HOST_A, {
        name: 'Billing keywords',
        conditions: BILLING_KEYWORDS,
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });

      expect((await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A)).reason).toBe(
        'already_assigned',
      );
      expect(
        (await systemPrisma.ticket.findUniqueOrThrow({ where: { id: TICKET_A } })).assignedUserId,
      ).toBe(SARA_A);
    });

    /**
     * The seam, live. This is the case that would have gone silently wrong if
     * the TAR-23 merge had kept this branch's stub binding: it would still have
     * said `deferred`, and nobody would have noticed rotation was switched off.
     */
    it('hands a ticket no rule matched to rotation, which places it', async () => {
      await makeAvailable(SARA_A);

      const result = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      expect(result).toMatchObject({
        outcome: 'fallback_assigned',
        ruleId: null,
        assignedUserId: SARA_A,
      });
      expect(
        (await systemPrisma.ticket.findUniqueOrThrow({ where: { id: TICKET_A } })).assignedUserId,
      ).toBe(SARA_A);

      const [event] = await systemPrisma.ticketEvent.findMany({ where: { ticketId: TICKET_A } });

      expect(event?.type).toBe('assigned');
      expect(event?.data).toMatchObject({ reason: 'Assigned by rotation' });
    });

    it('defers with a reason when no rule matches and nobody is available', async () => {
      // `beforeEach` has put every agent offline, so rotation reaches an answer
      // rather than a person: tenant A holds an active agent, so the reason is
      // `none_available` rather than `no_candidate_pool`.
      const result = await route(TENANT_A, TICKET_A, MESSAGE_A, CONTACT_A);

      expect(result).toMatchObject({ outcome: 'deferred', reason: 'none_available' });
      expect(
        (await systemPrisma.ticket.findUniqueOrThrow({ where: { id: TICKET_A } })).assignedUserId,
      ).toBeNull();

      const [event] = await systemPrisma.ticketEvent.findMany({ where: { ticketId: TICKET_A } });

      expect(event?.type).toBe('assignment_deferred');
      expect(event?.data).toMatchObject({ reason: 'none_available' });
    });

    /**
     * The other half of the reason vocabulary, and the case that proves the two
     * are told apart: tenant B's only user is a supervisor, and rotation's tenant
     * pool is agents only — a supervisor holds every agent permission but must
     * not silently start receiving customer tickets.
     */
    it('says `no_candidate_pool` when the tenant has no agent to rotate at all', async () => {
      const result = await route(TENANT_B, TICKET_B, MESSAGE_B, CONTACT_B);

      expect(result).toMatchObject({ outcome: 'deferred', reason: 'no_candidate_pool' });
    });

    it('matches nothing on a ticket with no message and no contact, rather than failing', async () => {
      await createRule(HOST_A, {
        name: 'Everything a ticket might have',
        conditions: [
          { type: 'keyword', match: 'any', values: ['invoice'] },
          { type: 'tag', match: 'any', tagIds: [VIP_TAG_A] },
        ],
        target: { kind: 'team', teamId: BILLING_TEAM_A },
      });
      await systemPrisma.ticket.update({
        where: { id: TICKET_A },
        data: { contactId: null },
      });

      expect((await route(TENANT_A, TICKET_A, null, null)).outcome).toBe('deferred');
    });
  });
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set to run the integration suite.`);
  }

  return value;
}
