import type { Server } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import {
  CANNED_RESPONSE_TRIGGER,
  type CannedResponseListResponse,
  type CannedResponseResponse,
} from '@whatsappcrm/contracts';
import request from 'supertest';
import { configureApp } from '../bootstrap';
import {
  CANNED_RESPONSE_CHANGED_EVENT,
  type CannedResponseChangedEvent,
} from '../events/domain-events';
import type { PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';

/**
 * TAR-477 end to end against a real PostgreSQL and the real request pipeline:
 * the CRUD surface 0011 publishes, the permission split, the after-commit domain
 * event TAR-485 will relay, and — the criterion this file exists for — **no
 * canned response leaks across tenants under any role**.
 *
 * Isolation is not a claim a unit test can make. It depends on the GUC being set
 * on the same connection as the statement, on TAR-48's policies, and on
 * `UNIQUE (tenant_id, shortcut)` leading with `tenant_id` so the constraint
 * cannot be read as an oracle. None of that a fake has.
 *
 * So every case runs against two tenants whose fixtures are deliberately
 * **identical in shape**: both hold a `/hours` response, with different text. If
 * any part of this surface leaked, the two would be indistinguishable and the
 * assertions would pass by accident — so the bodies differ and the assertions
 * name them.
 *
 * The two axes are the host (which tenant) and the role (which permission), the
 * same pair `routing-rules.int-spec.ts` varies. The role comes from the interim
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

const TENANT_A = '88888888-0000-7000-8000-000000000477';
const TENANT_B = '88888888-0000-7000-8000-000000000478';
const HOST_A = 'tar477-a.app.localhost';
const HOST_B = 'tar477-b.app.localhost';

const SUPERVISOR_A = '88888888-0000-7000-8000-0000004770a1';
const AGENT_A = '88888888-0000-7000-8000-0000004770a2';
const SUPERVISOR_B = '88888888-0000-7000-8000-0000004770b1';

const ENDPOINT = '/api/v1/canned-responses';

type Role = 'agent' | 'supervisor' | 'admin';

/** `supertest` types a body as `any`. These readers are where that stops. */
const errorCodeOf = (response: request.Response): string =>
  (response.body as { error: { code: string } }).error.code;

const responseOf = (response: request.Response): CannedResponseResponse =>
  response.body as CannedResponseResponse;

const listOf = (response: request.Response): CannedResponseListResponse =>
  response.body as CannedResponseListResponse;

const HOURS_A = { shortcut: '/hours', title: 'Opening hours', body: 'Tenant A is open 9–5.' };
const HOURS_B = { shortcut: '/hours', title: 'Opening hours', body: 'Tenant B is open 8–4.' };

describe('canned responses across two tenants', () => {
  let app: INestApplication;
  let systemPrisma: PrismaClient;
  let announced: CannedResponseChangedEvent[];

  /** One request as `role`, at `host`. The two axes every case below varies. */
  function call(host: string, role: Role) {
    return request
      .agent(app.getHttpServer() as Server)
      .set('Host', host)
      .set('x-dev-role', role);
  }

  async function create(host: string, body: Record<string, unknown>): Promise<request.Response> {
    return await call(host, 'supervisor').post(ENDPOINT).send(body);
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  async function seed(): Promise<void> {
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: 'tar477-fixture-a', name: 'TAR-477 fixture A', status: 'active' },
        { id: TENANT_B, slug: 'tar477-fixture-b', name: 'TAR-477 fixture B', status: 'active' },
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
          email: 'super@tar477-a.invalid',
          name: 'A Supervisor',
          role: 'supervisor',
          status: 'active',
        },
        {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: 'agent@tar477-a.invalid',
          name: 'A Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: SUPERVISOR_B,
          tenantId: TENANT_B,
          email: 'super@tar477-b.invalid',
          name: 'B Supervisor',
          role: 'supervisor',
          status: 'active',
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

    // Nothing subscribes to `canned_response.changed` until TAR-485 relays it,
    // so the only way to assert the producer's contract — after commit, and
    // only when a column moved — is to be that subscriber here.
    app
      .get(EventEmitter2)
      .on(CANNED_RESPONSE_CHANGED_EVENT, (event: CannedResponseChangedEvent) => {
        announced.push(event);
      });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    // Each test starts from the seeded shape, so they pass in any order.
    await systemPrisma.cannedResponse.deleteMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
    });
    await systemPrisma.auditLog.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    announced = [];
  });

  describe('the CRUD surface', () => {
    it('creates a response and returns it in the published shape', async () => {
      const response = await create(HOST_A, HOURS_A);

      expect(response.status).toBe(201);
      expect(responseOf(response)).toMatchObject({
        ...HOURS_A,
        // Stamped from the writing principal, never from the body.
        createdByUserId: SUPERVISOR_A,
      });
      // `is_shared` is true for every row the CHECK admits at v1, so it is not
      // a field the console has to render or a client can set.
      expect(responseOf(response)).not.toHaveProperty('isShared');
    });

    it('audits the write, because a canned response is text sent under the tenant’s name', async () => {
      await create(HOST_A, HOURS_A);

      const [audited] = await systemPrisma.auditLog.findMany({ where: { tenantId: TENANT_A } });

      expect(audited?.action).toBe('canned_response.created');
      expect(audited?.targetType).toBe('canned_response');
      // The shortcut and the title, never the body: `audit_logs` is exported for
      // compliance review and is not the place to discover customer detail.
      expect(audited?.metadata).toEqual({ shortcut: HOURS_A.shortcut, title: HOURS_A.title });
    });

    it('refuses a second response on the same shortcut', async () => {
      await create(HOST_A, HOURS_A);

      const clash = await create(HOST_A, { ...HOURS_A, body: 'A different answer.' });

      expect(clash.status).toBe(409);
      expect(errorCodeOf(clash)).toBe('conflict');
    });

    it('refuses a shortcut the composer could never type', async () => {
      // Uppercase, a second slash, and a missing trigger. The grammar is a Zod
      // check *and* `canned_responses_shortcut_format`; this asserts the first,
      // which is what turns each into a 400 rather than a 500.
      for (const shortcut of ['/Hours', '/support/hours', 'hours']) {
        const response = await create(HOST_A, { ...HOURS_A, shortcut });

        expect(response.status).toBe(400);
        expect(errorCodeOf(response)).toBe('validation_failed');
      }
    });

    it('refuses a whitespace-only title, which the database bound would accept', async () => {
      // `canned_responses_title_length` accepts `'   '` on purpose — a CHECK on
      // `trim()` would be stricter than the wire schema, which is the direction
      // that produces a 500. The trim lives in the contract, so this is a 400.
      const response = await create(HOST_A, { ...HOURS_A, title: '   ' });

      expect(response.status).toBe(400);
      expect(errorCodeOf(response)).toBe('validation_failed');
    });

    it('lists the whole set by shortcut, with the cursor the shape promises', async () => {
      await create(HOST_A, { shortcut: '/vat', title: 'VAT number', body: 'GB123.' });
      await create(HOST_A, HOURS_A);

      const response = await call(HOST_A, 'supervisor').get(ENDPOINT);

      expect(listOf(response).items.map((item) => item.shortcut)).toEqual(['/hours', '/vat']);
      // Bounded by `perTenant`, so the cursor is always null and the shape still
      // fits a generic list client.
      expect(listOf(response).nextCursor).toBeNull();
    });

    it('updates a response and answers with the row as it now stands', async () => {
      const created = responseOf(await create(HOST_A, HOURS_A));

      const updated = await call(HOST_A, 'supervisor')
        .patch(`${ENDPOINT}/${created.id}`)
        .send({ body: 'Tenant A is open 9–6.' });

      expect(updated.status).toBe(200);
      expect(responseOf(updated).body).toBe('Tenant A is open 9–6.');
      expect(responseOf(updated).shortcut).toBe(HOURS_A.shortcut);
    });

    it('refuses a shortcut another response in the tenant already holds', async () => {
      await create(HOST_A, HOURS_A);
      const vat = responseOf(
        await create(HOST_A, { shortcut: '/vat', title: 'VAT number', body: 'GB123.' }),
      );

      const clash = await call(HOST_A, 'supervisor')
        .patch(`${ENDPOINT}/${vat.id}`)
        .send({ shortcut: HOURS_A.shortcut });

      expect(clash.status).toBe(409);
      expect(errorCodeOf(clash)).toBe('conflict');
    });

    it('deletes idempotently', async () => {
      const created = responseOf(await create(HOST_A, HOURS_A));

      const first = await call(HOST_A, 'supervisor').delete(`${ENDPOINT}/${created.id}`);
      const again = await call(HOST_A, 'supervisor').delete(`${ENDPOINT}/${created.id}`);

      expect(first.status).toBe(204);
      expect(again.status).toBe(204);
    });

    it('answers not_found for an id nobody holds', async () => {
      const response = await call(HOST_A, 'supervisor').get(
        `${ENDPOINT}/88888888-0000-7000-8000-00000047709f`,
      );

      expect(response.status).toBe(404);
      expect(errorCodeOf(response)).toBe('not_found');
    });
  });

  /**
   * 0011 decision 1: there is no lookup route. The composer holds the whole set
   * and resolves a typed token against it, so what TAR-477's second acceptance
   * criterion actually requires of this API is that one `GET` carries everything
   * that resolution needs — the shortcut to match on and the body to insert.
   */
  describe('resolving a typed shortcut', () => {
    it('carries enough in one list response to expand `/hours` into its full text', async () => {
      await create(HOST_A, HOURS_A);
      await create(HOST_A, { shortcut: '/vat', title: 'VAT number', body: 'GB123.' });

      // Exactly what the composer does with the prop: match the token the agent
      // typed against the set it already has. No second request, no debounce.
      const typed = `${CANNED_RESPONSE_TRIGGER}hours`;
      const { items } = listOf(await call(HOST_A, 'agent').get(ENDPOINT));

      expect(items.find((item) => item.shortcut === typed)?.body).toBe(HOURS_A.body);
      // A token nothing matches resolves to nothing, which is the picker showing
      // no entries rather than an error.
      expect(items.find((item) => item.shortcut === '/nothing')).toBeUndefined();
    });
  });

  describe('permissions', () => {
    it('lets an agent read the library but never change it', async () => {
      // `canned_response:read` is granted to agent and above,
      // `canned_response:write` to supervisor and above (0004).
      const created = responseOf(await create(HOST_A, HOURS_A));

      const read = await call(HOST_A, 'agent').get(ENDPOINT);
      const written = await call(HOST_A, 'agent').post(ENDPOINT).send(HOURS_A);
      const patched = await call(HOST_A, 'agent')
        .patch(`${ENDPOINT}/${created.id}`)
        .send({ body: 'Sneaky.' });
      const removed = await call(HOST_A, 'agent').delete(`${ENDPOINT}/${created.id}`);

      expect(read.status).toBe(200);
      expect(listOf(read).items).toHaveLength(1);
      for (const refused of [written, patched, removed]) {
        expect(refused.status).toBe(403);
        expect(errorCodeOf(refused)).toBe('forbidden');
      }
      // And the row an agent tried to delete is still there.
      expect(await systemPrisma.cannedResponse.count({ where: { tenantId: TENANT_A } })).toBe(1);
    });
  });

  describe('the after-commit announcement TAR-485 relays', () => {
    it('announces a create and a delete, each once, naming the acting tenant', async () => {
      const created = responseOf(await create(HOST_A, HOURS_A));

      await call(HOST_A, 'supervisor').delete(`${ENDPOINT}/${created.id}`);

      expect(announced).toEqual([
        { tenantId: TENANT_A, cannedResponseId: created.id, change: 'saved' },
        { tenantId: TENANT_A, cannedResponseId: created.id, change: 'deleted' },
      ]);
    });

    it('says nothing for a patch that moves no column, and writes no audit row', async () => {
      // A broadcast that says nothing is still a broadcast: it would cost every
      // console on the tenant a refetch for a request that changed nothing.
      const created = responseOf(await create(HOST_A, HOURS_A));

      announced = [];
      await systemPrisma.auditLog.deleteMany({ where: { tenantId: TENANT_A } });

      const unchanged = await call(HOST_A, 'supervisor')
        .patch(`${ENDPOINT}/${created.id}`)
        .send({ body: HOURS_A.body });
      const empty = await call(HOST_A, 'supervisor').patch(`${ENDPOINT}/${created.id}`).send({});

      expect(unchanged.status).toBe(200);
      expect(empty.status).toBe(200);
      expect(responseOf(unchanged).updatedAt).toBe(created.updatedAt);
      expect(announced).toEqual([]);
      expect(await systemPrisma.auditLog.count({ where: { tenantId: TENANT_A } })).toBe(0);
    });

    it('says nothing for a delete that found nothing to delete', async () => {
      const created = responseOf(await create(HOST_A, HOURS_A));

      await call(HOST_A, 'supervisor').delete(`${ENDPOINT}/${created.id}`);
      announced = [];
      await call(HOST_A, 'supervisor').delete(`${ENDPOINT}/${created.id}`);

      expect(announced).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    it('shows each tenant only its own library', async () => {
      await create(HOST_A, HOURS_A);
      await create(HOST_B, HOURS_B);

      const listA = listOf(await call(HOST_A, 'agent').get(ENDPOINT));
      const listB = listOf(await call(HOST_B, 'supervisor').get(ENDPOINT));

      // Same shortcut in both, different text — so a leak would be visible as
      // the wrong body rather than as an extra row.
      expect(listA.items).toHaveLength(1);
      expect(listA.items[0]?.body).toBe(HOURS_A.body);
      expect(listB.items).toHaveLength(1);
      expect(listB.items[0]?.body).toBe(HOURS_B.body);
    });

    it('lets both tenants hold the same shortcut, because the unique index leads with the tenant', async () => {
      // Also the reason the constraint cannot be used as an oracle: a conflict
      // can only ever be caused by this tenant's own row.
      expect((await create(HOST_A, HOURS_A)).status).toBe(201);
      expect((await create(HOST_B, HOURS_B)).status).toBe(201);
    });

    it('answers not_found — never forbidden — for another tenant’s response', async () => {
      const mine = responseOf(await create(HOST_A, HOURS_A));

      // A 403 here would confirm the id exists somewhere, which is exactly what
      // 0004 refuses to do.
      const read = await call(HOST_B, 'supervisor').get(`${ENDPOINT}/${mine.id}`);
      const written = await call(HOST_B, 'supervisor')
        .patch(`${ENDPOINT}/${mine.id}`)
        .send({ body: 'Stolen.' });

      expect(read.status).toBe(404);
      expect(errorCodeOf(read)).toBe('not_found');
      expect(written.status).toBe(404);
      expect(errorCodeOf(written)).toBe('not_found');
      expect(
        (await systemPrisma.cannedResponse.findUniqueOrThrow({ where: { id: mine.id } })).body,
      ).toBe(HOURS_A.body);
    });

    it('refuses to delete another tenant’s response, and leaves it standing', async () => {
      const mine = responseOf(await create(HOST_A, HOURS_A));

      announced = [];
      // Delete is idempotent, so it answers 204 either way — the assertions that
      // matter are that the row survived and that nothing was announced to a
      // tenant that owns nothing.
      const response = await call(HOST_B, 'supervisor').delete(`${ENDPOINT}/${mine.id}`);

      expect(response.status).toBe(204);
      expect(announced).toEqual([]);
      expect(
        await systemPrisma.cannedResponse.findUnique({ where: { id: mine.id } }),
      ).not.toBeNull();
    });

    it('files every audit row under the tenant that wrote it', async () => {
      await create(HOST_A, HOURS_A);
      await create(HOST_B, HOURS_B);

      expect(await systemPrisma.auditLog.count({ where: { tenantId: TENANT_A } })).toBe(1);
      expect(await systemPrisma.auditLog.count({ where: { tenantId: TENANT_B } })).toBe(1);
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
