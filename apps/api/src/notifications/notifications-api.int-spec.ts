import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { CursorPage, NotificationResponse } from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * TAR-596 end to end against a real PostgreSQL and the real request pipeline:
 * the generalised inbox 0002 and 0009 decision 7 publish, and — the criterion
 * this file exists for — **no notification leaks across tenants or across
 * recipients under any role**.
 *
 * Neither claim is one a unit test can make. Both depend on the GUC being set on
 * the same connection as the statement, on TAR-48's policies, and on the
 * `recipient_user_id` narrowing the service adds on top of them. A fake agrees
 * with all three whether or not they are there.
 *
 * So the fixture is deliberately **symmetrical**: two tenants each holding a
 * `workflow_notify` addressed to their own supervisor, and inside tenant A a
 * second supervisor holding one of their own. If any part of this surface
 * leaked, the rows would be indistinguishable and the assertions would pass by
 * accident — so every message differs and the assertions name them.
 *
 * The two axes are the host (which tenant) and the role (which principal), the
 * pair `canned-responses.int-spec.ts` already varies. The role comes from the
 * interim stub, which resolves the **lowest-id active user** holding it, so the
 * ids below are ordered on purpose: `SUPERVISOR_A` is the caller and
 * `SUPERVISOR_A2` is the colleague whose inbox must stay invisible.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after, so an interrupted
 * run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '59600000-0000-7000-8000-000000000001';
const TENANT_B = '59600000-0000-7000-8000-000000000002';
const HOST_A = 'tar596-a.app.localhost';
const HOST_B = 'tar596-b.app.localhost';

// Ordered: the stub resolves the lowest-id active user holding the role, so
// `SUPERVISOR_A` is the caller at `HOST_A` and `SUPERVISOR_A2` is the colleague.
const SUPERVISOR_A = '59600000-0000-7000-8000-0000000000a1';
const SUPERVISOR_A2 = '59600000-0000-7000-8000-0000000000a2';
const AGENT_A = '59600000-0000-7000-8000-0000000000a3';
const SUPERVISOR_B = '59600000-0000-7000-8000-0000000000b1';

const WABA_A = '59600000-0000-7000-8000-00000000000a';
const WABA_B = '59600000-0000-7000-8000-00000000000b';
const ACCOUNT_A = '59600000-0000-7000-8000-00000000001a';
const ACCOUNT_B = '59600000-0000-7000-8000-00000000001b';
const CONTACT_A = '59600000-0000-7000-8000-00000000002a';
const CONTACT_B = '59600000-0000-7000-8000-00000000002b';
const CONVERSATION_A = '59600000-0000-7000-8000-00000000003a';
const CONVERSATION_B = '59600000-0000-7000-8000-00000000003b';
const TICKET_A = '59600000-0000-7000-8000-00000000004a';
const TICKET_B = '59600000-0000-7000-8000-00000000004b';
const POLICY_A = '59600000-0000-7000-8000-00000000005a';
const TIMER_A = '59600000-0000-7000-8000-00000000006a';
const ESCALATED_EVENT_A = '59600000-0000-7000-8000-00000000007a';

const BREACH_A = '59600000-0000-7000-8000-0000000000f1';
const NOTIFY_A = '59600000-0000-7000-8000-0000000000f2';
const BROKEN_A = '59600000-0000-7000-8000-0000000000f3';
const ESCALATION_A = '59600000-0000-7000-8000-0000000000f4';
const COLLEAGUE_A = '59600000-0000-7000-8000-0000000000f5';
const NOTIFY_B = '59600000-0000-7000-8000-0000000000f6';

const WORKFLOW_ID = '59600000-0000-7000-8000-00000000009a';
const RUN_ID = '59600000-0000-7000-8000-00000000009b';

const ENDPOINT = '/api/v1/notifications';

const TICKET_NUMBER_A = 4_596;
const TICKET_NUMBER_B = 8_596;

type Role = 'agent' | 'supervisor' | 'admin';

/** `supertest` types a body as `any`. These readers are where that stops. */
const pageOf = (response: request.Response): CursorPage<NotificationResponse> =>
  response.body as CursorPage<NotificationResponse>;

const notificationOf = (response: request.Response): NotificationResponse =>
  response.body as NotificationResponse;

const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

/**
 * The neighbouring single-type view's page, read only for its ids — enough to
 * assert that an `escalation` row is still reachable where it does belong.
 */
const escalationIdsOf = (response: request.Response): string[] =>
  (response.body as CursorPage<{ id: string }>).items.map((item) => item.id);

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value.length === 0) {
    throw new Error(`${name} must be set to run the integration suite.`);
  }

  return value;
}

describe('the notification inbox across two tenants and two recipients', () => {
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

  async function seedTenants(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar596-fixture-a', name: 'TAR-596 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar596-fixture-b', name: 'TAR-596 fixture B', status: 'active' },
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
          id: SUPERVISOR_A,
          tenantId: TENANT_A,
          email: 'super@tar596-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: SUPERVISOR_A2,
          tenantId: TENANT_A,
          email: 'super2@tar596-a.invalid',
          name: 'A Second Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar596-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUPERVISOR_B,
          tenantId: TENANT_B,
          email: 'super@tar596-b.invalid',
          name: 'B Supervisor',
          role: 'supervisor',
          status: 'active',
        },
      ],
    });
  }

  /** One ticket per tenant, which is what every notification hangs off. */
  async function seedTickets(): Promise<void> {
    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: 'tar596-fixture-a-waba' },
        { id: WABA_B, tenantId: TENANT_B, wabaId: 'tar596-fixture-b-waba' },
      ],
    });
    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: 'tar596-fixture-a-phone',
          displayPhoneNumber: '+10000005961',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: 'tar596-fixture-b-phone',
          displayPhoneNumber: '+10000005962',
        },
      ],
    });
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+10000059601' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000059602' },
      ],
    });
    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A,
        },
        {
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: ACCOUNT_B,
          contactId: CONTACT_B,
        },
      ],
    });
    await systemPrisma.ticket.createMany({
      data: [
        {
          id: TICKET_A,
          tenantId: TENANT_A,
          number: TICKET_NUMBER_A,
          status: 'open',
          conversationId: CONVERSATION_A,
          contactId: CONTACT_A,
        },
        {
          id: TICKET_B,
          tenantId: TENANT_B,
          number: TICKET_NUMBER_B,
          status: 'open',
          conversationId: CONVERSATION_B,
          contactId: CONTACT_B,
        },
      ],
    });
    // The `sla_breach` row's columns are non-null behind
    // `notifications_sla_breach_columns`, and `sla_timer_id` is a real foreign
    // key — so the breach case needs a policy and a timer, not a literal.
    await systemPrisma.slaPolicy.create({
      data: { id: POLICY_A, tenantId: TENANT_A, name: 'TAR-596 fixture', firstResponseMinutes: 15 },
    });
    await systemPrisma.slaTimer.create({
      data: {
        id: TIMER_A,
        tenantId: TENANT_A,
        ticketId: TICKET_A,
        policyId: POLICY_A,
        kind: 'first_response',
        state: 'breached',
        dueAt: new Date('2026-08-22T08:00:00.000Z'),
        breachedAt: new Date('2026-08-22T08:00:01.000Z'),
      },
    });
    // Same for the escalation row, whose `ticket_event_id` is both its group key
    // and a composite foreign key into the audit trail.
    await systemPrisma.ticketEvent.create({
      data: {
        id: ESCALATED_EVENT_A,
        tenantId: TENANT_A,
        ticketId: TICKET_A,
        type: 'escalated',
        actorUserId: AGENT_A,
        data: { reason: 'The customer has asked for a manager.' },
      },
    });
  }

  /**
   * Six rows, seeded fresh per test: four addressed to the caller (one of each
   * type), one to their colleague, and one in the other tenant. `created_at` is
   * explicit and ordered so the keyset assertions are about the sort rather than
   * about how fast the inserts ran.
   */
  async function seedNotifications(): Promise<void> {
    await systemPrisma.notification.createMany({
      data: [
        {
          id: BREACH_A,
          tenantId: TENANT_A,
          type: 'sla_breach',
          ticketId: TICKET_A,
          recipientUserId: SUPERVISOR_A,
          slaTimerId: TIMER_A,
          kind: 'first_response',
          dueAt: new Date('2026-08-22T08:00:00.000Z'),
          createdAt: new Date('2026-08-22T09:00:00.000Z'),
        },
        {
          id: NOTIFY_A,
          tenantId: TENANT_A,
          type: 'workflow_notify',
          ticketId: TICKET_A,
          recipientUserId: SUPERVISOR_A,
          data: { workflowId: WORKFLOW_ID, workflowRunId: RUN_ID, message: 'For A supervisor.' },
          dedupeKey: `${RUN_ID}:0`,
          createdAt: new Date('2026-08-22T09:01:00.000Z'),
        },
        {
          id: BROKEN_A,
          tenantId: TENANT_A,
          type: 'workflow_broken',
          ticketId: TICKET_A,
          recipientUserId: SUPERVISOR_A,
          data: { workflowId: WORKFLOW_ID, workflowRunId: RUN_ID },
          dedupeKey: `workflow-broken:${WORKFLOW_ID}`,
          createdAt: new Date('2026-08-22T09:02:00.000Z'),
        },
        {
          id: ESCALATION_A,
          tenantId: TENANT_A,
          type: 'escalation',
          ticketId: TICKET_A,
          ticketEventId: ESCALATED_EVENT_A,
          recipientUserId: SUPERVISOR_A,
          createdAt: new Date('2026-08-22T09:03:00.000Z'),
        },
        {
          id: COLLEAGUE_A,
          tenantId: TENANT_A,
          type: 'workflow_notify',
          ticketId: TICKET_A,
          recipientUserId: SUPERVISOR_A2,
          data: { workflowId: WORKFLOW_ID, workflowRunId: RUN_ID, message: 'For the colleague.' },
          dedupeKey: `${RUN_ID}:1`,
          createdAt: new Date('2026-08-22T09:04:00.000Z'),
        },
        {
          id: NOTIFY_B,
          tenantId: TENANT_B,
          type: 'workflow_notify',
          ticketId: TICKET_B,
          recipientUserId: SUPERVISOR_B,
          data: { workflowId: WORKFLOW_ID, workflowRunId: RUN_ID, message: 'For tenant B.' },
          dedupeKey: `${RUN_ID}:0`,
          createdAt: new Date('2026-08-22T09:05:00.000Z'),
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
    await seedTenants();
    await seedTickets();

    const { AppModule } = await import('../app.module');

    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    configureApp(app);
    await app.init();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Each test starts from the seeded shape, so they pass in any order.
    await systemPrisma.notification.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await seedNotifications();
  });

  describe('the list', () => {
    it('returns the caller’s own rows, newest first, in the published shape', async () => {
      const response = await call(HOST_A, 'supervisor').get(ENDPOINT);

      expect(response.status).toBe(200);
      // Newest first, and `escalation` is absent — it has its own surface.
      expect(pageOf(response).items.map((item) => item.id)).toEqual([BROKEN_A, NOTIFY_A, BREACH_A]);
      expect(pageOf(response).nextCursor).toBeNull();
    });

    it('flattens `data` into named fields and reads the ticket number once', async () => {
      const response = await call(HOST_A, 'supervisor').get(ENDPOINT);
      const notify = pageOf(response).items.find((item) => item.id === NOTIFY_A);

      expect(notify).toEqual({
        id: NOTIFY_A,
        type: 'workflow_notify',
        ticketId: TICKET_A,
        ticketNumber: TICKET_NUMBER_A,
        slaTimerId: null,
        dueAt: null,
        message: 'For A supervisor.',
        workflowId: WORKFLOW_ID,
        workflowRunId: RUN_ID,
        acknowledgedAt: null,
        createdAt: '2026-08-22T09:01:00.000Z',
      });
    });

    it('publishes the SLA columns on a breach row and nulls the workflow ones', async () => {
      const response = await call(HOST_A, 'supervisor').get(ENDPOINT);
      const breach = pageOf(response).items.find((item) => item.id === BREACH_A);

      expect(breach).toMatchObject({
        type: 'sla_breach',
        slaTimerId: TIMER_A,
        dueAt: '2026-08-22T08:00:00.000Z',
        message: null,
        workflowId: null,
      });
    });

    it('narrows to one type when the caller asks for one', async () => {
      const response = await call(HOST_A, 'supervisor').get(`${ENDPOINT}?type=workflow_broken`);

      expect(pageOf(response).items.map((item) => item.id)).toEqual([BROKEN_A]);
    });

    it('paginates on the keyset the index serves', async () => {
      const first = await call(HOST_A, 'supervisor').get(`${ENDPOINT}?limit=2`);

      expect(pageOf(first).items.map((item) => item.id)).toEqual([BROKEN_A, NOTIFY_A]);
      expect(pageOf(first).nextCursor).not.toBeNull();

      const second = await call(HOST_A, 'supervisor').get(
        `${ENDPOINT}?limit=2&cursor=${encodeURIComponent(pageOf(first).nextCursor ?? '')}`,
      );

      // No overlap and no gap: the resume predicate excludes the row the cursor
      // names rather than the whole timestamp.
      expect(pageOf(second).items.map((item) => item.id)).toEqual([BREACH_A]);
      expect(pageOf(second).nextCursor).toBeNull();
    });

    it('hides acknowledged rows by default and shows them on request', async () => {
      await systemPrisma.notification.update({
        where: { id: NOTIFY_A },
        data: { acknowledgedAt: new Date('2026-08-22T10:00:00.000Z') },
      });

      const landing = await call(HOST_A, 'supervisor').get(ENDPOINT);
      const everything = await call(HOST_A, 'supervisor').get(
        `${ENDPOINT}?unacknowledgedOnly=false`,
      );

      expect(pageOf(landing).items.map((item) => item.id)).not.toContain(NOTIFY_A);
      expect(pageOf(everything).items.map((item) => item.id)).toContain(NOTIFY_A);
    });

    it('refuses a cursor it cannot read rather than silently serving page one', async () => {
      const response = await call(HOST_A, 'supervisor').get(`${ENDPOINT}?cursor=not-a-cursor`);

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });
  });

  describe('isolation', () => {
    it('never shows one supervisor what a colleague was told', async () => {
      const response = await call(HOST_A, 'supervisor').get(`${ENDPOINT}?unacknowledgedOnly=false`);

      expect(pageOf(response).items.map((item) => item.id)).not.toContain(COLLEAGUE_A);
    });

    it('never shows one tenant another tenant’s rows, and each sees its own', async () => {
      const a = await call(HOST_A, 'supervisor').get(ENDPOINT);
      const b = await call(HOST_B, 'supervisor').get(ENDPOINT);

      // Both fixtures are the same shape, so a leak would be invisible unless
      // the assertions name the messages rather than count the rows.
      expect(pageOf(a).items.map((item) => item.message)).toContain('For A supervisor.');
      expect(pageOf(a).items.map((item) => item.message)).not.toContain('For tenant B.');
      expect(pageOf(b).items.map((item) => item.id)).toEqual([NOTIFY_B]);
      expect(pageOf(b).items.map((item) => item.message)).toEqual(['For tenant B.']);
    });

    it('serves an agent an empty page rather than a 403', async () => {
      // The role scoping is the recipient narrowing, not a permission: an agent
      // holds `ticket:read` and may call this, and gets what was addressed to
      // them, which here is nothing.
      const response = await call(HOST_A, 'agent').get(ENDPOINT);

      expect(response.status).toBe(200);
      expect(pageOf(response).items).toEqual([]);
    });

    it('leaves `escalation` rows to their own endpoint', async () => {
      const inbox = await call(HOST_A, 'supervisor').get(`${ENDPOINT}?unacknowledgedOnly=false`);
      const escalations = await call(HOST_A, 'supervisor').get('/api/v1/escalation-alerts');

      expect(pageOf(inbox).items.map((item) => item.id)).not.toContain(ESCALATION_A);
      expect(escalationIdsOf(escalations)).toEqual([ESCALATION_A]);
    });
  });

  describe('the acknowledge', () => {
    it('stamps the row and is idempotent on a second call', async () => {
      const first = await call(HOST_A, 'supervisor').post(`${ENDPOINT}/${NOTIFY_A}/acknowledge`);

      expect(first.status).toBe(200);
      expect(notificationOf(first).acknowledgedAt).not.toBeNull();

      const second = await call(HOST_A, 'supervisor').post(`${ENDPOINT}/${NOTIFY_A}/acknowledge`);

      // First write wins: the timestamp answers "when did you see this", and a
      // second click must not move it. Nothing here is a 409.
      expect(second.status).toBe(200);
      expect(notificationOf(second).acknowledgedAt).toBe(notificationOf(first).acknowledgedAt);
    });

    it('is the same act as acknowledging through `/sla-alerts`', async () => {
      await call(HOST_A, 'supervisor').post(`/api/v1/sla-alerts/${BREACH_A}/acknowledge`);

      const response = await call(HOST_A, 'supervisor').get(
        `${ENDPOINT}?unacknowledgedOnly=false&type=sla_breach`,
      );

      // One table, one unread count: a breach acknowledged on the SLA surface is
      // acknowledged here too, because both write the same column on the same row.
      expect(pageOf(response).items[0]?.acknowledgedAt).not.toBeNull();
    });

    it('answers not_found — never forbidden — for a colleague’s row', async () => {
      const response = await call(HOST_A, 'supervisor').post(
        `${ENDPOINT}/${COLLEAGUE_A}/acknowledge`,
      );

      // A 403 would confirm the id names a real notification somebody else was
      // sent, which is the enumeration 0002's security section forbids.
      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
      expect(
        (await systemPrisma.notification.findUnique({ where: { id: COLLEAGUE_A } }))
          ?.acknowledgedAt,
      ).toBeNull();
    });

    it('answers not_found for another tenant’s row', async () => {
      const response = await call(HOST_A, 'supervisor').post(`${ENDPOINT}/${NOTIFY_B}/acknowledge`);

      expect(response.status).toBe(404);
      expect(
        (await systemPrisma.notification.findUnique({ where: { id: NOTIFY_B } }))?.acknowledgedAt,
      ).toBeNull();
    });

    it('answers not_found for an `escalation` row, which is not on this surface', async () => {
      const response = await call(HOST_A, 'supervisor').post(
        `${ENDPOINT}/${ESCALATION_A}/acknowledge`,
      );

      expect(response.status).toBe(404);
    });

    it('refuses an id that is not a UUID', async () => {
      const response = await call(HOST_A, 'supervisor').post(`${ENDPOINT}/not-a-uuid/acknowledge`);

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });
  });
});
