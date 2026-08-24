import type { OnboardingStepId } from '@whatsappcrm/contracts';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { Prisma } from '../../generated/prisma/client';
import type { TenantPrisma } from '../../prisma/prisma.tokens';
import { OnboardingStepCompletedError } from './tenant-onboarding.errors';
import type {
  OnboardingFacts,
  OnboardingSkipRow,
  TenantOnboardingReader,
} from './tenant-onboarding.reader';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * What the one write does, and — as often — what it declines to do.
 *
 * The three cases that carry the design are the 409 on a completed step, the
 * already-skipped no-op that keeps `updatedAt` from churning when two tabs send
 * the same click, and the reopen that clears `skipped_at` on a **completed**
 * step and still answers `completed`. Each is one `if` away from being wrong in
 * a way the console would not show.
 */

const TENANT_ID = '83400000-0000-7000-8000-000000000011';
const ADMIN_ID = '83400000-0000-7000-8000-0000000000a1';

const TENANT_CREATED = new Date('2026-01-01T00:00:00.000Z');
const BRANDING_CREATED = new Date('2026-04-01T00:00:00.000Z');
const SKIPPED = new Date('2026-05-01T00:00:00.000Z');
const ROW_TOUCHED = new Date('2026-05-02T00:00:00.000Z');

function skipRow(overrides: Partial<OnboardingSkipRow> = {}): OnboardingSkipRow {
  return { stepId: 'set_branding', skippedAt: SKIPPED, updatedAt: ROW_TOUCHED, ...overrides };
}

/** What the service passed to `upsert`, named so the assertions can read it. */
interface UpsertArgument {
  where: { tenantId_stepId: { tenantId: string; stepId: string } };
  create: { tenantId: string; stepId: string; skippedAt: Date; skippedByUserId: string | null };
  update: { skippedAt: Date; skippedByUserId: string | null };
}

/**
 * The first upsert argument, typed.
 *
 * Read off the mock rather than matched with a nested `expect.objectContaining`,
 * which types its result `any` and trips `no-unsafe-assignment` — and reads
 * worse besides.
 */
function upsertArgument(upsert: jest.Mock): UpsertArgument {
  const [first] = upsert.mock.calls as readonly (readonly [UpsertArgument])[];

  if (first === undefined) {
    throw new Error('The service wrote nothing, so there is no upsert to inspect.');
  }

  return first[0];
}

describe('TenantOnboardingService', () => {
  let upsert: jest.Mock;
  let update: jest.Mock;
  let facts: jest.Mock;
  let tenantContext: TenantContextService;
  let service: TenantOnboardingService;

  function gathered(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
    return {
      tenantCreatedAt: TENANT_CREATED,
      completedAt: new Map<OnboardingStepId, Date>(),
      skips: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    upsert = jest.fn().mockImplementation(({ create }: { create: OnboardingSkipRow }) =>
      Promise.resolve({
        stepId: create.stepId,
        skippedAt: create.skippedAt,
        updatedAt: ROW_TOUCHED,
      }),
    );
    update = jest
      .fn()
      .mockImplementation(({ where }: { where: { tenantId_stepId: { stepId: string } } }) =>
        Promise.resolve({
          stepId: where.tenantId_stepId.stepId,
          skippedAt: null,
          updatedAt: ROW_TOUCHED,
        }),
      );
    facts = jest.fn().mockResolvedValue(gathered());
    tenantContext = new TenantContextService();

    const tx = {
      tenantOnboardingStep: { upsert, update },
    } as unknown as Prisma.TransactionClient;

    service = new TenantOnboardingService(
      {
        $tenantTransaction: (work: (client: Prisma.TransactionClient) => unknown) => work(tx),
      } as unknown as TenantPrisma,
      { facts } as unknown as TenantOnboardingReader,
      tenantContext,
    );
  });

  /** Runs `work` as if the pipeline had resolved a tenant and its admin. */
  function asAdmin<T>(work: () => Promise<T>): Promise<T> {
    return tenantContext.run(
      { requestId: 'req_onboarding', tenantId: TENANT_ID, userId: ADMIN_ID },
      work,
    );
  }

  describe('skipping a step', () => {
    it('writes the skip and attributes it to the admin who pressed it', async () => {
      const checklist = await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'skip' }),
      );

      const written = upsertArgument(upsert);

      expect(written.where).toEqual({
        tenantId_stepId: { tenantId: TENANT_ID, stepId: 'set_branding' },
      });
      expect(written.create).toMatchObject({
        tenantId: TENANT_ID,
        stepId: 'set_branding',
        skippedByUserId: ADMIN_ID,
      });
      // The whole checklist, so a caller cannot render a progress meter from a
      // checklist it has half of.
      expect(checklist.steps).toHaveLength(3);
      expect(checklist.steps[2]?.status).toBe('skipped');
    });

    it('refuses a step that is already completed, and writes nothing', async () => {
      facts.mockResolvedValue(
        gathered({
          completedAt: new Map<OnboardingStepId, Date>([['set_branding', BRANDING_CREATED]]),
        }),
      );

      await expect(
        asAdmin(() =>
          service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'skip' }),
        ),
      ).rejects.toBeInstanceOf(OnboardingStepCompletedError);
      expect(upsert).not.toHaveBeenCalled();
    });

    it('is a no-op on an already-skipped step, so `updatedAt` does not churn', async () => {
      facts.mockResolvedValue(gathered({ skips: [skipRow()] }));

      const checklist = await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'skip' }),
      );

      expect(upsert).not.toHaveBeenCalled();
      // Two tabs racing the same button see the same instant, not a rewritten one.
      expect(checklist.steps[2]?.skippedAt).toBe(SKIPPED.toISOString());
    });

    it('re-skips a step that was skipped and then reopened', async () => {
      // The row survives a reopen with a null `skipped_at`, so this is an update
      // rather than an insert — and the unique key is what makes it one row.
      facts.mockResolvedValue(gathered({ skips: [skipRow({ skippedAt: null })] }));

      await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'skip' }),
      );

      expect(upsertArgument(upsert).update.skippedByUserId).toBe(ADMIN_ID);
    });
  });

  describe('reopening a step', () => {
    it('clears `skipped_at` and puts the step back to pending', async () => {
      facts.mockResolvedValue(gathered({ skips: [skipRow()] }));

      const checklist = await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'reopen' }),
      );

      expect(update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId_stepId: { tenantId: TENANT_ID, stepId: 'set_branding' } },
          data: { skippedAt: null },
        }),
      );
      expect(checklist.steps[2]).toEqual({
        id: 'set_branding',
        status: 'pending',
        completedAt: null,
        skippedAt: null,
      });
    });

    it('is a no-op on a step that was never skipped', async () => {
      await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'invite_agents', intent: 'reopen' }),
      );

      // An insert here would write a row saying nothing, and move `updatedAt`
      // for a click that changed nothing.
      expect(update).not.toHaveBeenCalled();
      expect(upsert).not.toHaveBeenCalled();
    });

    it('clears the skip on a completed step but still answers `completed`', async () => {
      // Divergence 3 from the mock, which resets any reopen to `pending`. The
      // real API cannot: completion is derived, so there is nothing to un-derive.
      facts.mockResolvedValue(
        gathered({
          completedAt: new Map<OnboardingStepId, Date>([['set_branding', BRANDING_CREATED]]),
          skips: [skipRow()],
        }),
      );

      const checklist = await asAdmin(() =>
        service.apply({ tenantId: TENANT_ID, stepId: 'set_branding', intent: 'reopen' }),
      );

      expect(update).toHaveBeenCalled();
      expect(checklist.steps[2]).toEqual({
        id: 'set_branding',
        status: 'completed',
        completedAt: BRANDING_CREATED.toISOString(),
        skippedAt: null,
      });
    });
  });

  it('gathers the facts and writes inside one transaction', async () => {
    const order: string[] = [];
    facts.mockImplementation(() => {
      order.push('read');
      return Promise.resolve(gathered());
    });
    upsert.mockImplementation(() => {
      order.push('write');
      return Promise.resolve(skipRow({ stepId: 'invite_agents' }));
    });

    await asAdmin(() =>
      service.apply({ tenantId: TENANT_ID, stepId: 'invite_agents', intent: 'skip' }),
    );

    // Read first: completion is derived, so "is this already done" is a query
    // rather than a column, and the 409 depends on it having run.
    expect(order).toEqual(['read', 'write']);
  });
});
