import type { ConfigService } from '@nestjs/config';
import type { SystemPrisma } from '../../prisma/prisma.tokens';
import { DomainOwnershipChecker } from './domain-ownership.checker';
import { DomainVerificationSweeper } from './domain-verification.sweeper';

const NOW = new Date('2026-08-16T12:00:00.000Z');
const TTL_DAYS = 7;
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

interface PendingRow {
  id: string;
  hostname: string;
  verificationToken: string | null;
  verificationAttempts: number;
  verificationLastCheckedAt: Date | null;
}

function pending(overrides: Partial<PendingRow> = {}): PendingRow {
  return {
    id: '0192f00e-0000-7000-8000-000000000e01',
    hostname: 'support.acme.example',
    verificationToken: TOKEN,
    verificationAttempts: 0,
    verificationLastCheckedAt: null,
    ...overrides,
  };
}

/** The two `tenant_domains` calls the sweeper makes, and nothing else. */
function systemPrismaWith(rows: PendingRow[]) {
  const deleteMany = jest.fn().mockResolvedValue({ count: 0 });
  const update = jest.fn().mockResolvedValue(undefined);
  const findMany = jest.fn().mockResolvedValue(rows);

  return {
    client: {
      tenantDomain: { findMany, deleteMany, update },
    } as unknown as SystemPrisma,
    deleteMany,
    findMany,
    update,
  };
}

interface RecheckQuery {
  where: { OR: { verificationAttempts?: unknown; verificationLastCheckedAt: unknown }[] };
  orderBy: unknown;
  take: number;
}

/** The `findMany` argument the re-check pass issued. */
function recheckQuery(findMany: jest.Mock): RecheckQuery {
  const [call] = findMany.mock.calls as [RecheckQuery][];

  if (call === undefined) {
    throw new Error('The sweeper issued no re-check query');
  }

  return call[0];
}

/**
 * Would the row the sweeper's `where` describes include this one? The backoff
 * lives in the query now, so this is what asserting on it means — a fake that
 * answered `findMany` by evaluating the clause would be re-implementing
 * PostgreSQL to test a `where` against itself.
 */
function matchesDueClauses(where: RecheckQuery['where'], row: PendingRow): boolean {
  return where.OR.some((clause) => {
    const attempts = clause.verificationAttempts as { gte?: number } | number | undefined;
    const lastChecked = clause.verificationLastCheckedAt as { lte?: Date } | null;

    if (typeof attempts === 'number' && attempts !== row.verificationAttempts) {
      return false;
    }

    if (typeof attempts === 'object' && row.verificationAttempts < (attempts.gte ?? 0)) {
      return false;
    }

    if (lastChecked === null) {
      return row.verificationLastCheckedAt === null;
    }

    return (
      row.verificationLastCheckedAt !== null &&
      lastChecked.lte !== undefined &&
      row.verificationLastCheckedAt <= lastChecked.lte
    );
  });
}

function sweeperOver(rows: PendingRow[], proved: boolean) {
  const prisma = systemPrismaWith(rows);
  const check = jest
    .fn()
    .mockResolvedValue(proved ? { proved: true } : { proved: false, reason: 'record_not_found' });
  const config = { getOrThrow: () => TTL_DAYS } as unknown as ConfigService;

  return {
    ...prisma,
    check,
    sweeper: new DomainVerificationSweeper(
      prisma.client,
      { check } as unknown as DomainOwnershipChecker,
      config,
    ),
  };
}

describe('DomainVerificationSweeper', () => {
  describe('releasing lapsed claims', () => {
    it('deletes unverified custom claims past the window, and only those', async () => {
      // A claim reserves a globally unique hostname. Without this, one tenant
      // typing a competitor's domain holds it forever.
      const { sweeper, deleteMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      expect(deleteMany).toHaveBeenCalledWith({
        where: {
          kind: 'custom',
          verifiedAt: null,
          verificationRequestedAt: {
            lt: new Date(NOW.getTime() - TTL_DAYS * 24 * 60 * 60 * 1_000),
          },
        },
      });
    });

    it('releases before it re-checks, so an expiring claim does not spend a query first', async () => {
      const order: string[] = [];
      const { sweeper, deleteMany } = sweeperOver([pending()], false);

      deleteMany.mockImplementation(() => {
        order.push('release');

        return Promise.resolve({ count: 1 });
      });

      const report = await sweeper.sweep(NOW);

      expect(order).toEqual(['release']);
      expect(report.expired).toBe(1);
    });
  });

  describe('re-checking pending claims', () => {
    it('is what makes verification arrive without the tenant clicking anything', async () => {
      const { sweeper, check, update } = sweeperOver([pending()], true);

      const report = await sweeper.sweep(NOW);

      expect(check).toHaveBeenCalledWith('support.acme.example', TOKEN);
      expect(report).toMatchObject({ checked: 1, verified: 1 });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verifiedAt: NOW,
            verificationFailureReason: null,
          }) as object,
        }),
      );
    });

    it('records the reason on a claim that is still not published', async () => {
      const { sweeper, update } = sweeperOver([pending()], false);

      const report = await sweeper.sweep(NOW);

      expect(report).toMatchObject({ checked: 1, verified: 0 });
      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            verifiedAt: null,
            verificationFailureReason: 'record_not_found',
          }) as object,
        }),
      );
    });

    it('skips a row with no token rather than asking DNS about nothing', async () => {
      // `tenant_domains_custom_needs_token` makes this unreachable; the guard is
      // for a row written before that constraint existed.
      const { sweeper, check } = sweeperOver([pending({ verificationToken: null })], false);

      await sweeper.sweep(NOW);

      expect(check).not.toHaveBeenCalled();
    });
  });

  /**
   * The backoff is a `where`, not a filter after `take`, and that is the whole
   * point: applied in JavaScript, a backed-off row still consumed one of the
   * hundred slots, so past a hundred pending claims the batch was permanently
   * full of rows it was going to skip and a claim made today never entered it.
   */
  describe('choosing the batch', () => {
    it('asks the database for due claims rather than filtering after take', async () => {
      const { sweeper, findMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      const query = recheckQuery(findMany);

      expect(query.take).toBe(100);
      expect(query.where.OR).toBeDefined();
    });

    it('leaves a backed-off claim out of the batch', async () => {
      // Two attempts already made puts the next check five minutes out; one
      // minute ago is not due.
      const { sweeper, findMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      expect(
        matchesDueClauses(
          recheckQuery(findMany).where,
          pending({
            verificationAttempts: 2,
            verificationLastCheckedAt: new Date(NOW.getTime() - 60_000),
          }),
        ),
      ).toBe(false);
    });

    it('takes a claim that has waited out its backoff, and one never checked', async () => {
      const { sweeper, findMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      const { where } = recheckQuery(findMany);

      expect(
        matchesDueClauses(
          where,
          pending({
            verificationAttempts: 2,
            verificationLastCheckedAt: new Date(NOW.getTime() - 10 * 60_000),
          }),
        ),
      ).toBe(true);
      expect(matchesDueClauses(where, pending())).toBe(true);
    });

    it('holds a long-abandoned claim at the ceiling rather than running off the table', async () => {
      const { sweeper, findMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      const { where } = recheckQuery(findMany);

      expect(
        matchesDueClauses(
          where,
          pending({
            verificationAttempts: 500,
            verificationLastCheckedAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
          }),
        ),
      ).toBe(true);
      expect(
        matchesDueClauses(
          where,
          pending({
            verificationAttempts: 500,
            verificationLastCheckedAt: new Date(NOW.getTime() - 60 * 60_000),
          }),
        ),
      ).toBe(false);
    });

    it('orders by last checked, never-checked first, so no claim can be starved', async () => {
      // Oldest-claim-first put the same long-abandoned rows at the head of every
      // batch. This is the round robin the backoff table assumes.
      const { sweeper, findMany } = sweeperOver([], false);

      await sweeper.sweep(NOW);

      expect(recheckQuery(findMany).orderBy).toEqual({
        verificationLastCheckedAt: { sort: 'asc', nulls: 'first' },
      });
    });
  });
});
