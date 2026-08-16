import { TenantContextService } from '../common/tenant-context/tenant-context.service';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from '../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../prisma/tenant-scope.extension';
import { PlanLimitExceededError } from './entitlements.errors';
import { PlanLimitsService } from './plan-limits.service';

/**
 * The seat cap against a real PostgreSQL, as `whatsappcrm_app` — the role that
 * holds no `BYPASSRLS` (TAR-405).
 *
 * Three properties live here because the unit spec's fake cannot prove any of
 * them:
 *
 *   * **The count is confined to one tenant by RLS**, not by a `WHERE` somebody
 *     could forget to write. Tenant B fills every seat it has and tenant A —
 *     capped at the same number, and empty — is still free to invite.
 *   * **`tenant_entitlements` is readable on the tenant connection**, which is
 *     the whole reason TAR-403 put the caps in a tenant-scoped table rather than
 *     in the platform-wide `plans`, and why ADR 0009 Amendment 1 ruling 3 kept
 *     that when it widened the row. A row for another tenant is invisible, so a
 *     tenant cannot inherit a neighbour's ceiling.
 *   * **The advisory lock actually serialises**, so two concurrent seat checks
 *     against the last free seat cannot both pass. That is the difference
 *     between a cap and a suggestion, and only a real database shows it.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Two fixture tenants
 * carrying fixed ids, deleted before the run as well as after it, so an
 * interrupted run cleans up on the next one.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '40588888-8888-7888-8888-888888888801';
const TENANT_B = '40588888-8888-7888-8888-888888888802';

const REQUEST_ID = 'tar405-int-spec';

/** A cap small enough that the fixture can sit exactly on it. */
const SEAT_CAP = 2;

/**
 * `PlanEntitlementsSchema`'s shape with one seat ceiling set — the whole object
 * every time, because `tenant_entitlements_shape` refuses a row whose five limit
 * keys are not all present (ADR 0009 Amendment 1 ruling 3).
 */
function entitlementsWithSeats(seats: number | null): Prisma.InputJsonObject {
  return {
    features: [],
    limits: {
      seats,
      conversationsPerPeriod: null,
      whatsappNumbers: null,
      teams: null,
      knowledgeDocuments: null,
    },
  };
}

describe('the plan seat cap', () => {
  const tenantContext = new TenantContextService();
  const planLimits = new PlanLimitsService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;

  /** Runs `work` with a tenant in scope and no principal — the cap needs no session. */
  function asTenant<T>(tenantId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: REQUEST_ID, tenantId, userId: null, principal: null },
      work,
    );
  }

  /**
   * The check as its callers make it: inside the transaction that would consume
   * the seat, on the tenant connection.
   */
  function checkSeat(tenantId: string): Promise<void> {
    return asTenant(tenantId, () =>
      tenantPrisma.$tenantTransaction((tx: Prisma.TransactionClient) =>
        planLimits.assertSeatAvailable(tx, tenantId),
      ),
    );
  }

  async function removeFixture(): Promise<void> {
    // Users, invites and the limits row all cascade from the tenant.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    await removeFixture();

    for (const [tenantId, slug] of [
      [TENANT_A, 'tar405-fixture-a'],
      [TENANT_B, 'tar405-fixture-b'],
    ] as const) {
      await systemPrisma.tenant.create({
        data: {
          id: tenantId,
          slug,
          name: `TAR-405 fixture ${slug}`,
          // `trialing`, because that is the state self-signup lands a tenant in
          // and the one the cap exists for. It also proves the gate admits it:
          // every statement below runs through `assert_tenant_active`, so a
          // tenant in this status that could not be read would fail the suite.
          status: 'trialing',
          domains: {
            create: {
              hostname: `${slug}.app.localhost`,
              kind: 'platform',
              isPrimary: true,
              verifiedAt: new Date(),
            },
          },
          entitlements: {
            create: {
              planKey: 'trial',
              planName: 'Trial',
              entitlements: entitlementsWithSeats(SEAT_CAP),
            },
          },
        },
      });
    }
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    // Each test starts from "nobody holds a seat in either tenant".
    await systemPrisma.user.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.invite.deleteMany({ where: { tenantId: { in: [TENANT_A, TENANT_B] } } });
    await systemPrisma.tenantEntitlements.updateMany({
      where: { tenantId: { in: [TENANT_A, TENANT_B] } },
      data: { entitlements: entitlementsWithSeats(SEAT_CAP) },
    });
  });

  it('allows a seat while the tenant is under its cap', async () => {
    await fillSeats(TENANT_A, 1);

    await expect(checkSeat(TENANT_A)).resolves.toBeUndefined();
  });

  it('refuses the seat that would take the tenant past its cap', async () => {
    await fillSeats(TENANT_A, SEAT_CAP);

    await expect(checkSeat(TENANT_A)).rejects.toThrow(PlanLimitExceededError);
  });

  /**
   * The isolation assertion. Tenant B is full; tenant A has the same cap and
   * nobody in it. If the count were not confined by RLS, A would inherit B's
   * usage and be refused a seat it has.
   */
  it('counts only the tenant in scope', async () => {
    await fillSeats(TENANT_B, SEAT_CAP);

    await expect(checkSeat(TENANT_B)).rejects.toThrow(PlanLimitExceededError);
    await expect(checkSeat(TENANT_A)).resolves.toBeUndefined();
  });

  /**
   * A neighbour's ceiling must be invisible too, not merely unused: the caps
   * live in a tenant-scoped table precisely so that reading one is an RLS
   * question rather than a `WHERE tenant_id` somebody remembers to add.
   */
  it('reads its own cap and not a neighbour raised one', async () => {
    await systemPrisma.tenantEntitlements.update({
      where: { tenantId: TENANT_B },
      data: { entitlements: entitlementsWithSeats(null) },
    });
    await fillSeats(TENANT_A, SEAT_CAP);

    // B is unlimited and A is full. A must still be refused.
    await expect(checkSeat(TENANT_A)).rejects.toThrow(PlanLimitExceededError);
    await expect(checkSeat(TENANT_B)).resolves.toBeUndefined();
  });

  it('counts an outstanding invitation as a seat already taken', async () => {
    await fillSeats(TENANT_A, SEAT_CAP - 1);
    await inviteSeat(TENANT_A, 'pending@tar405.invalid');

    await expect(checkSeat(TENANT_A)).rejects.toThrow(PlanLimitExceededError);
  });

  /**
   * `InviteService.revoke` leaves the `invited` user row alone on purpose, so a
   * count that keyed off `users.status` alone would charge the tenant for every
   * invitation it ever withdrew. This is the case that catches that mistake.
   */
  it('gives the seat back when an invitation is revoked', async () => {
    await fillSeats(TENANT_A, SEAT_CAP - 1);
    const invite = await inviteSeat(TENANT_A, 'withdrawn@tar405.invalid');

    await expect(checkSeat(TENANT_A)).rejects.toThrow(PlanLimitExceededError);

    await systemPrisma.invite.update({
      where: { id: invite },
      data: { revokedAt: new Date() },
    });

    await expect(checkSeat(TENANT_A)).resolves.toBeUndefined();
  });

  /** A `removed` member has given their seat back; a `suspended` one has not. */
  it.each([
    ['suspended', false],
    ['removed', true],
  ] as const)('a %s member releases their seat: %s', async (status, released) => {
    await fillSeats(TENANT_A, SEAT_CAP - 1);
    await fillSeats(TENANT_A, 1, status);

    const check = checkSeat(TENANT_A);

    await (released
      ? expect(check).resolves.toBeUndefined()
      : expect(check).rejects.toThrow(PlanLimitExceededError));
  });

  /**
   * Two requests racing for the last seat. Without the advisory lock both read
   * "1 of 2", both pass, and the tenant lands on three seats against a cap of
   * two — the overshoot 0009 calls out. With it, the second waits for the first
   * to commit and then sees the seat gone.
   *
   * The winner's transaction takes the seat inside itself, so the loser is
   * looking at a committed row rather than at an uncommitted one.
   */
  it('does not let two concurrent checks share the last seat', async () => {
    await fillSeats(TENANT_A, SEAT_CAP - 1);

    const claimLastSeat = (email: string): Promise<void> =>
      asTenant(TENANT_A, () =>
        tenantPrisma.$tenantTransaction(async (tx: Prisma.TransactionClient) => {
          await planLimits.assertSeatAvailable(tx, TENANT_A);
          await tx.user.create({
            data: { tenantId: TENANT_A, email, name: 'Racer', role: 'agent', status: 'active' },
            select: { id: true },
          });
        }),
      );

    const outcomes = await Promise.allSettled([
      claimLastSeat('racer-one@tar405.invalid'),
      claimLastSeat('racer-two@tar405.invalid'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);

    const [refused] = outcomes.filter((outcome) => outcome.status === 'rejected');

    expect(refused?.reason).toBeInstanceOf(PlanLimitExceededError);
  });

  /** Written through `SystemPrisma`, so the fixture is not itself under test. */
  async function fillSeats(
    tenantId: string,
    count: number,
    status: 'active' | 'suspended' | 'removed' = 'active',
  ): Promise<void> {
    for (let seat = 0; seat < count; seat += 1) {
      await systemPrisma.user.create({
        data: {
          tenantId,
          email: `${status}-${seat}-${Math.trunc(performance.now() * 1000)}@tar405.invalid`,
          name: 'Fixture Member',
          role: 'agent',
          status,
        },
        select: { id: true },
      });
    }
  }

  /** One outstanding invitation, in the shape `InviteService.create` leaves behind. */
  async function inviteSeat(tenantId: string, email: string): Promise<string> {
    const invite = await systemPrisma.invite.create({
      data: {
        tenantId,
        email,
        role: 'agent',
        tokenHash: `fixture-${email}`,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
      select: { id: true },
    });

    // The `users` row the real flow writes alongside it. `invited` occupies no
    // seat of its own — the invitation is what holds it — so this row is here to
    // prove the count does not double it.
    await systemPrisma.user.create({
      data: { tenantId, email, name: 'Invitee', role: 'agent', status: 'invited' },
      select: { id: true },
    });

    return invite.id;
  }
});

function requireEnv(name: string): string {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(
      `${name} is not set. Run the suite through \`pnpm test:db\` with the stack up: ` +
        'pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login',
    );
  }

  return value;
}
