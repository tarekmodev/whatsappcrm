import { PLAN_KEY_MAX_LENGTH, PLAN_KEY_PATTERN } from '@whatsappcrm/contracts';
import type { Prisma, PrismaClient } from '../generated/prisma/client';
import { createPrismaClient } from './prisma-client.factory';

/**
 * `plans_key_format` — the CHECK that makes `GET /billing/plans` answerable
 * (TAR-657).
 *
 * The catalogue is platform-wide and unfiltered on the read: every `is_active`
 * row goes to every tenant's billing page, and the console validates the whole
 * response against `PlanListResponseSchema`. So a single row whose `key` the
 * published contract refuses is not a bad row, it is the billing page down for
 * every tenant on the platform — which is exactly what a leaked test fixture
 * keyed `tar405-cap-plan` did. The console now drops the offending plan instead
 * of failing the parse; this constraint is the other half, and the half that
 * stops the row existing at all.
 *
 * It needs its own integration test because nothing else in the toolchain sees
 * it. Prisma's schema language cannot express a CHECK and its describer does not
 * report one, so `migrate dev` proposes neither to create nor to drop it: if it
 * disappeared, every unit test would still pass. Same arrangement, and the same
 * reasoning, as `canned_responses_shortcut_format` (TAR-475) and
 * `plans_entitlements_shape` (TAR-617).
 *
 * The catalog assertions compare the constraint body against the contract's own
 * `PLAN_KEY_PATTERN` rather than against a regex copied into this file, so the
 * database and the contract cannot drift apart while both look right on their
 * own.
 *
 * ⚠️ Writes to the database it is pointed at, and commits. Fixture rows carry
 * fixed ids and a `tar657_` key prefix, and are removed before the run as well
 * as after it, so an interrupted run cleans up on the next one. `plans` is
 * shared platform data, so nothing here touches a row it did not create.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const PLAN_ID = '65765765-6576-7657-8657-657657657001';
const FIXTURE_PREFIX = 'tar657_';

describe('the plan catalogue schema', () => {
  let systemPrisma: PrismaClient;

  /** A valid row, so each test varies only the column it is about. */
  function validRow(
    overrides: Partial<Prisma.PlanUncheckedCreateInput> = {},
  ): Prisma.PlanUncheckedCreateInput {
    return {
      id: PLAN_ID,
      key: `${FIXTURE_PREFIX}valid`,
      name: 'TAR-657 fixture',
      priceMinorUnits: 0,
      entitlements: {
        features: [],
        limits: {
          seats: null,
          conversationsPerPeriod: null,
          whatsappNumbers: null,
          teams: null,
          knowledgeDocuments: null,
        },
      },
      ...overrides,
    };
  }

  async function removeFixture(): Promise<void> {
    await systemPrisma.plan.deleteMany({ where: { key: { startsWith: FIXTURE_PREFIX } } });
  }

  beforeAll(async () => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));

    await removeFixture();
  });

  afterAll(async () => {
    await removeFixture();
    await systemPrisma.$disconnect();
  });

  beforeEach(async () => {
    await removeFixture();
  });

  describe('the catalog', () => {
    it("carries plans_key_format, with the contract's own pattern in its body", async () => {
      const [constraint] = await systemPrisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_key_format'
      `;

      // Asserting the body rather than the name: a constraint quietly widened to
      // `CHECK (true)` passes a name-only check and fails every behaviour test
      // below.
      //
      // The regex is `PLAN_KEY_PATTERN` with `PLAN_KEY_MAX_LENGTH` folded into
      // the quantifier — the same spelling `tenant_entitlements_plan_key_format`
      // uses for the copy of this value, and the reason the two are written out
      // from the contract's constants here rather than pasted in.
      expect(constraint?.definition).toContain(
        `~ '^[a-z][a-z0-9_]{0,${PLAN_KEY_MAX_LENGTH - 1}}$'`,
      );
    });

    it('keeps plans_entitlements_shape, which this migration must not touch', async () => {
      const [constraint] = await systemPrisma.$queryRaw<{ definition: string }[]>`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'public.plans'::regclass AND conname = 'plans_entitlements_shape'
      `;

      expect(constraint?.definition).toContain('features');
    });

    it('holds no key the published contract would refuse', async () => {
      // The constraint proves this for every row written after it landed. This
      // asserts it for the rows that were already there — the migration repairs
      // them, and a repair that missed one is a billing page that is still down.
      const keys = await systemPrisma.plan.findMany({ select: { key: true } });

      expect(keys.filter(({ key }) => !PLAN_KEY_PATTERN.test(key))).toEqual([]);
    });
  });

  describe('the key', () => {
    it('accepts the grammar the contract publishes', async () => {
      const key = `${FIXTURE_PREFIX}growth_2`;

      expect(PLAN_KEY_PATTERN.test(key)).toBe(true);

      await expect(systemPrisma.plan.create({ data: validRow({ key }) })).resolves.toMatchObject({
        key,
      });
    });

    it.each([
      // The one that took the page down: a fixture key with hyphens in it.
      ['a hyphen', 'tar405-cap-plan'],
      ['an uppercase letter', 'tar657_Growth'],
      ['a leading digit', '657_growth'],
      ['a space', 'tar657 growth'],
      ['a dot, which reads as a path segment', 'tar657.growth'],
      ['nothing at all', ''],
    ])('refuses a key containing %s', async (_reason, key) => {
      // Both halves, in one test: the database refuses it, and the contract the
      // console parses against would have refused it too. Asserting only the
      // first would let the two drift into disagreeing about a real key.
      expect(PLAN_KEY_PATTERN.test(key)).toBe(false);

      await expect(systemPrisma.plan.create({ data: validRow({ key }) })).rejects.toThrow(
        /plans_key_format/,
      );
    });

    it(`refuses a key longer than the contract's ${PLAN_KEY_MAX_LENGTH} characters`, async () => {
      const key = `${FIXTURE_PREFIX}${'a'.repeat(PLAN_KEY_MAX_LENGTH)}`;

      await expect(systemPrisma.plan.create({ data: validRow({ key }) })).rejects.toThrow(
        /plans_key_format/,
      );
    });

    it('refuses a rename onto a key it would have refused on insert', async () => {
      // A CHECK covers the UPDATE path too, and an admin tool editing a key is
      // the likelier way a bad one arrives now that the fixtures are fixed.
      await systemPrisma.plan.create({ data: validRow() });

      await expect(
        systemPrisma.plan.update({ where: { id: PLAN_ID }, data: { key: 'tar657-renamed' } }),
      ).rejects.toThrow(/plans_key_format/);
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
