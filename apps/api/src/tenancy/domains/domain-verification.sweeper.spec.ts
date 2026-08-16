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

  return {
    client: {
      tenantDomain: { findMany: jest.fn().mockResolvedValue(rows), deleteMany, update },
    } as unknown as SystemPrisma,
    deleteMany,
    update,
  };
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

    it('backs off, so a domain whose DNS is never coming is not asked every cycle', async () => {
      // Two attempts already made puts the next check five minutes out; one
      // minute ago is not due.
      const { sweeper, check } = sweeperOver(
        [
          pending({
            verificationAttempts: 2,
            verificationLastCheckedAt: new Date(NOW.getTime() - 60_000),
          }),
        ],
        false,
      );

      const report = await sweeper.sweep(NOW);

      expect(check).not.toHaveBeenCalled();
      expect(report.checked).toBe(0);
    });

    it('checks a claim that has waited out its backoff', async () => {
      const { sweeper, check } = sweeperOver(
        [
          pending({
            verificationAttempts: 2,
            verificationLastCheckedAt: new Date(NOW.getTime() - 10 * 60_000),
          }),
        ],
        true,
      );

      await sweeper.sweep(NOW);

      expect(check).toHaveBeenCalledTimes(1);
    });

    it('holds a long-abandoned claim at the ceiling rather than running off the table', async () => {
      const { sweeper, check } = sweeperOver(
        [
          pending({
            verificationAttempts: 500,
            verificationLastCheckedAt: new Date(NOW.getTime() - 24 * 60 * 60_000),
          }),
        ],
        false,
      );

      await sweeper.sweep(NOW);

      expect(check).toHaveBeenCalledTimes(1);
    });

    it('skips a row with no token rather than asking DNS about nothing', async () => {
      // `tenant_domains_custom_needs_token` makes this unreachable; the guard is
      // for a row written before that constraint existed.
      const { sweeper, check } = sweeperOver([pending({ verificationToken: null })], false);

      await sweeper.sweep(NOW);

      expect(check).not.toHaveBeenCalled();
    });
  });
});
