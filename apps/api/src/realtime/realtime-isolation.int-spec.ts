import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'node:crypto';
import { AUTH_POLICY, permissionsForRole, type SessionPrincipal } from '@whatsappcrm/contracts';
import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../generated/prisma/client';
import type { AuthRedisClient } from '../identity/auth-redis.client';
import { SessionCacheService } from '../identity/session-cache.service';
import { SessionService } from '../identity/session.service';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { CannedResponseResourceService } from './canned-response-resource.service';
import { ConversationAccessService } from './conversation-access.service';

/**
 * TAR-69's isolation criteria — "a client cannot join another tenant's room" and
 * "`conversation.subscribe` is rejected for a conversation outside the caller's
 * tenant" — against a real PostgreSQL with TAR-48's policies applied.
 *
 * The gateway spec proves what a *client* can ask for. This proves what the
 * database will answer, and the two together are the criterion: a unit test can
 * show `maySubscribe` passes an id to `findUnique`, and only this can show that
 * `conversations` actually carries the `tenant_isolation` policy and that the
 * app role's grants reach it. Everything below runs as `whatsappcrm_app`, the
 * role holding no `BYPASSRLS`.
 *
 * The session half matters just as much and is easier to overlook: a realtime
 * ticket names a `sessionId`, and `resolveBySessionId` is the only thing between
 * that id and a socket in the room it claims. It is a lookup by a globally
 * unique id with no tenant in the predicate, so RLS is *the* thing stopping a
 * ticket minted in one tenant from resolving a principal in another.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar69-fixture` marker, deleted before the run as
 * well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '69555555-5555-7555-8555-555555555501';
const TENANT_B = '69555555-5555-7555-8555-555555555502';
const USER_A = '69555555-5555-7555-8555-5555555555a1';
const USER_B = '69555555-5555-7555-8555-5555555555a2';
const TEAM_A = '69555555-5555-7555-8555-5555555555b1';
const WABA_A = '69555555-5555-7555-8555-5555555555c3';
const WABA_B = '69555555-5555-7555-8555-5555555555c4';
const ACCOUNT_A = '69555555-5555-7555-8555-5555555555c1';
const ACCOUNT_B = '69555555-5555-7555-8555-5555555555c2';
const CONTACT_A = '69555555-5555-7555-8555-5555555555d1';
const CONTACT_B = '69555555-5555-7555-8555-5555555555d2';
const CONTACT_A_UNASSIGNED = '69555555-5555-7555-8555-5555555555d3';
const CONTACT_A_TEAM = '69555555-5555-7555-8555-5555555555d4';
const CONVERSATION_A = '69555555-5555-7555-8555-5555555555e1';
const CONVERSATION_B = '69555555-5555-7555-8555-5555555555e2';
const UNASSIGNED_A = '69555555-5555-7555-8555-5555555555e3';
const TEAM_ROUTED_A = '69555555-5555-7555-8555-5555555555e4';
const CANNED_RESPONSE_A = '69555555-5555-7555-8555-5555555555f5';
const CANNED_RESPONSE_B = '69555555-5555-7555-8555-5555555555f6';

const REQUEST_ID = 'tar69-int-spec';
const FIXTURE_PREFIX = 'tar69-fixture';

describe('the realtime gateway cannot be pointed at another tenant', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let access: ConversationAccessService;
  let sessions: SessionService;
  let cannedResponses: CannedResponseResourceService;

  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null },
      async () => await work(),
    );
  }

  function principal(overrides: Partial<SessionPrincipal> = {}): SessionPrincipal {
    const role = overrides.role ?? 'agent';

    return {
      userId: USER_A,
      tenantId: TENANT_A,
      email: 'ada@tar69.invalid',
      displayName: 'Ada Agent',
      role,
      permissions: [...permissionsForRole(role)],
      teamIds: [],
      sessionId: '69555555-5555-7555-8555-5555555555f1',
      expiresAt: '2036-12-31T23:59:59.000Z',
      ...overrides,
    };
  }

  async function removeFixture(): Promise<void> {
    // Everything below cascades from `tenants`.
    await systemPrisma.tenant.deleteMany({ where: { slug: { startsWith: FIXTURE_PREFIX } } });
  }

  /**
   * One live session for `userId`, and the id a realtime ticket would carry.
   *
   * `token_hash` is globally unique, so each call mints its own — a test that
   * revokes a session must not be able to break the one the next test seeds.
   */
  async function seedSession(tenantId: string, userId: string): Promise<string> {
    const tokenHash = `${FIXTURE_PREFIX}-${randomUUID()}`;

    const [row] = await systemPrisma.$queryRaw<{ id: string }[]>`
      INSERT INTO sessions (
        id, tenant_id, user_id, token_hash,
        expires_at, absolute_expires_at, last_seen_at, created_at
      )
      VALUES (
        gen_random_uuid(), ${tenantId}::uuid, ${userId}::uuid, ${tokenHash},
        now() + make_interval(secs => ${AUTH_POLICY.sessionIdleMs / 1_000}::double precision),
        now() + make_interval(secs => ${AUTH_POLICY.sessionAbsoluteMs / 1_000}::double precision),
        now(), now()
      )
      RETURNING id
    `;

    if (row === undefined) {
      throw new Error('The fixture session was not written.');
    }

    return row.id;
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    access = new ConversationAccessService(tenantPrisma);
    cannedResponses = new CannedResponseResourceService(tenantPrisma);
    // `resolveBySessionId` reads Postgres and nothing else — it does not consult
    // or write the principal cache, because both are keyed by a token hash it
    // does not have. A Redis client that always degrades makes that explicit.
    sessions = new SessionService(
      tenantPrisma,
      new SessionCacheService({ run: () => Promise.resolve(null) } as unknown as AuthRedisClient),
      new EventEmitter2(),
    );

    await removeFixture();

    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-69 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-69 tenant B', status: 'active' },
      ],
    });

    await systemPrisma.user.createMany({
      data: [
        {
          id: USER_A,
          tenantId: TENANT_A,
          email: 'ada@tar69.invalid',
          name: 'Ada Agent',
          role: 'agent',
          status: 'active',
        },
        {
          id: USER_B,
          tenantId: TENANT_B,
          email: 'bo@tar69.invalid',
          name: 'Bo Agent',
          role: 'agent',
          status: 'active',
        },
      ],
    });

    await systemPrisma.team.create({
      data: { id: TEAM_A, tenantId: TENANT_A, name: 'TAR-69 support' },
    });

    await systemPrisma.whatsappBusinessAccount.createMany({
      data: [
        { id: WABA_A, tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a` },
        { id: WABA_B, tenantId: TENANT_B, wabaId: `${FIXTURE_PREFIX}-waba-b` },
      ],
    });

    await systemPrisma.whatsappAccount.createMany({
      data: [
        {
          id: ACCOUNT_A,
          tenantId: TENANT_A,
          whatsappBusinessAccountId: WABA_A,
          phoneNumberId: `${FIXTURE_PREFIX}-a`,
          displayPhoneNumber: '+10000000001',
        },
        {
          id: ACCOUNT_B,
          tenantId: TENANT_B,
          whatsappBusinessAccountId: WABA_B,
          phoneNumberId: `${FIXTURE_PREFIX}-b`,
          displayPhoneNumber: '+10000000002',
        },
      ],
    });

    // One contact per conversation: `conversations` is unique on
    // `(tenant_id, whatsapp_account_id, contact_id)` — one thread per customer
    // per number — so three threads in tenant A need three customers.
    await systemPrisma.contact.createMany({
      data: [
        { id: CONTACT_A, tenantId: TENANT_A, phoneE164: '+10000000011' },
        { id: CONTACT_A_UNASSIGNED, tenantId: TENANT_A, phoneE164: '+10000000013' },
        { id: CONTACT_A_TEAM, tenantId: TENANT_A, phoneE164: '+10000000014' },
        { id: CONTACT_B, tenantId: TENANT_B, phoneE164: '+10000000012' },
      ],
    });

    await systemPrisma.conversation.createMany({
      data: [
        {
          id: CONVERSATION_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A,
          assignedUserId: USER_A,
        },
        {
          id: UNASSIGNED_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A_UNASSIGNED,
        },
        {
          id: TEAM_ROUTED_A,
          tenantId: TENANT_A,
          whatsappAccountId: ACCOUNT_A,
          contactId: CONTACT_A_TEAM,
          assignedTeamId: TEAM_A,
        },
        {
          id: CONVERSATION_B,
          tenantId: TENANT_B,
          whatsappAccountId: ACCOUNT_B,
          contactId: CONTACT_B,
          assignedUserId: USER_B,
        },
      ],
    });

    // Both tenants hold `/hours`, with different text. `UNIQUE (tenant_id,
    // shortcut)` allows it, and it is what makes the read-back assertions below
    // fail loudly on a leak: the wrong tenant's row is a different body rather
    // than an absence that could also mean "the fixture did not load".
    await systemPrisma.cannedResponse.createMany({
      data: [
        {
          id: CANNED_RESPONSE_A,
          tenantId: TENANT_A,
          shortcut: '/hours',
          title: 'Opening hours',
          body: 'Tenant A is open 09:00–17:00.',
        },
        {
          id: CANNED_RESPONSE_B,
          tenantId: TENANT_B,
          shortcut: '/hours',
          title: 'Opening hours',
          body: 'Tenant B is open 08:00–20:00.',
        },
      ],
    });
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  describe('conversation.subscribe', () => {
    it('admits a caller to their own tenant’s conversation', async () => {
      await expect(
        asTenant(TENANT_A, async () => access.maySubscribe(principal(), CONVERSATION_A)),
      ).resolves.toBe(true);
    });

    it('refuses a conversation that belongs to the other tenant', async () => {
      // The id is real and live for its owner, so this is a refusal rather than
      // an empty database. RLS is what supplies it: nothing in `maySubscribe`
      // compares tenant ids.
      await expect(
        asTenant(TENANT_B, async () =>
          access.maySubscribe(principal({ tenantId: TENANT_B, userId: USER_B }), CONVERSATION_B),
        ),
      ).resolves.toBe(true);
      await expect(
        asTenant(TENANT_A, async () => access.maySubscribe(principal(), CONVERSATION_B)),
      ).resolves.toBe(false);
    });

    it('admits every agent on the tenant to a conversation nobody has claimed', async () => {
      // TAR-68's amendment 4, applied to the socket so it answers the same as
      // the route: a customer wrote in, and a thread visible to nobody is an
      // unanswered customer rather than an isolation property.
      await expect(
        asTenant(TENANT_A, async () => access.maySubscribe(principal(), UNASSIGNED_A)),
      ).resolves.toBe(true);
      await expect(
        asTenant(TENANT_A, async () =>
          access.maySubscribe(principal({ role: 'supervisor' }), UNASSIGNED_A),
        ),
      ).resolves.toBe(true);
    });

    it('still refuses a conversation another agent has claimed', async () => {
      await expect(
        asTenant(TENANT_A, async () =>
          access.maySubscribe(principal({ userId: USER_B }), CONVERSATION_A),
        ),
      ).resolves.toBe(false);
    });

    it('admits an agent to a team’s conversation only while they are in that team', async () => {
      await expect(
        asTenant(TENANT_A, async () => access.maySubscribe(principal(), TEAM_ROUTED_A)),
      ).resolves.toBe(false);
      await expect(
        asTenant(TENANT_A, async () =>
          access.maySubscribe(principal({ teamIds: [TEAM_A] }), TEAM_ROUTED_A),
        ),
      ).resolves.toBe(true);
    });
  });

  describe('the session a realtime ticket names', () => {
    it('resolves inside its own tenant', async () => {
      const sessionId = await seedSession(TENANT_A, USER_A);

      await expect(
        asTenant(TENANT_A, async () => sessions.resolveBySessionId(sessionId)),
      ).resolves.toMatchObject({ tenantId: TENANT_A, userId: USER_A, role: 'agent' });
    });

    it('resolves to nothing when read from the other tenant', async () => {
      // The scenario: a ticket minted for tenant B, presented on a socket that
      // somehow got tenant A into scope. The handshake compares the two anyway,
      // but this is the layer that makes the comparison redundant rather than
      // load-bearing.
      const sessionId = await seedSession(TENANT_B, USER_B);

      await expect(
        asTenant(TENANT_A, async () => sessions.resolveBySessionId(sessionId)),
      ).resolves.toBeNull();
    });

    it('resolves to nothing once the session is revoked', async () => {
      const sessionId = await seedSession(TENANT_A, USER_A);

      await systemPrisma.$executeRaw`
        UPDATE sessions SET revoked_at = now(), revoked_reason = 'logout_all' WHERE id = ${sessionId}::uuid
      `;

      await expect(
        asTenant(TENANT_A, async () => sessions.resolveBySessionId(sessionId)),
      ).resolves.toBeNull();
    });

    it('resolves to nothing once the user is no longer active', async () => {
      const sessionId = await seedSession(TENANT_A, USER_A);

      await systemPrisma.user.update({ where: { id: USER_A }, data: { status: 'suspended' } });

      try {
        await expect(
          asTenant(TENANT_A, async () => sessions.resolveBySessionId(sessionId)),
        ).resolves.toBeNull();
      } finally {
        await systemPrisma.user.update({ where: { id: USER_A }, data: { status: 'active' } });
      }
    });

    it('does not slide the session’s idle deadline', async () => {
      // An open socket is not evidence that anybody is at the keyboard. Sliding
      // here would keep a session alive for as long as a tab stayed open.
      const sessionId = await seedSession(TENANT_A, USER_A);

      const before = await systemPrisma.session.findUniqueOrThrow({
        where: { id: sessionId },
        select: { expiresAt: true, lastSeenAt: true },
      });

      await asTenant(TENANT_A, async () => sessions.resolveBySessionId(sessionId));

      await expect(
        systemPrisma.session.findUniqueOrThrow({
          where: { id: sessionId },
          select: { expiresAt: true, lastSeenAt: true },
        }),
      ).resolves.toEqual(before);
    });
  });

  /**
   * The row a canned-response relay publishes (TAR-485).
   *
   * The relay opens a scope from the event's own `tenantId` and reads the row
   * back under it, so the isolation claim is not "the relay compares tenant ids"
   * — it does not, and there is nothing in the handler to compare. It is that
   * `canned_responses` carries TAR-48's policy and that the app role's grants go
   * through it, which only a real database can answer.
   */
  describe('the canned response a relay reads back', () => {
    it('resolves inside its own tenant, with that tenant’s text', async () => {
      await expect(
        asTenant(TENANT_A, async () => cannedResponses.findForRelay(CANNED_RESPONSE_A)),
      ).resolves.toMatchObject({ shortcut: '/hours', body: 'Tenant A is open 09:00–17:00.' });
    });

    it('resolves to nothing when the event names another tenant’s row', async () => {
      // The scenario a forged or stale `tenantId` takes: the id is real and live
      // for its owner, so this is a refusal rather than an empty table. Nothing
      // is published, which is exactly what the handler does with `null`.
      await expect(
        asTenant(TENANT_A, async () => cannedResponses.findForRelay(CANNED_RESPONSE_B)),
      ).resolves.toBeNull();
      await expect(
        asTenant(TENANT_B, async () => cannedResponses.findForRelay(CANNED_RESPONSE_A)),
      ).resolves.toBeNull();
    });

    it('gives each tenant its own row for a shortcut they both hold', async () => {
      await expect(
        asTenant(TENANT_B, async () => cannedResponses.findForRelay(CANNED_RESPONSE_B)),
      ).resolves.toMatchObject({ body: 'Tenant B is open 08:00–20:00.' });
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
