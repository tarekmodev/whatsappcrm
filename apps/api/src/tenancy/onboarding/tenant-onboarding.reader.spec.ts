import type { OnboardingStep, OnboardingStepId } from '@whatsappcrm/contracts';
import { OnboardingChecklistResponseSchema } from '@whatsappcrm/contracts';
import type { Prisma } from '../../generated/prisma/client';
import type { TenantPrisma } from '../../prisma/prisma.tokens';
import { TenantNotFoundError } from '../tenant-deactivation.errors';
import {
  assembleChecklist,
  TenantOnboardingReader,
  type OnboardingFacts,
  type OnboardingSkipRow,
} from './tenant-onboarding.reader';

/**
 * The derivation TAR-832 decides, in the two halves it is written in: what the
 * facts are read from, and what the checklist says about them.
 *
 * The second half is a pure function, so every rule that is easy to get wrong —
 * completed beating skipped, the null `completedAt` while anything is pending,
 * the floor under `updatedAt` — is asserted here without a database. What only
 * a real PostgreSQL can prove (that the skip actually persists, that RLS keeps
 * one tenant's checklist out of another's) is in
 * `tenant-onboarding-api.int-spec.ts` and belongs there.
 */

const TENANT_ID = '83400000-0000-7000-8000-000000000001';

/** Fixed instants, ordered, so "the latest of these" is a readable assertion. */
const TENANT_CREATED = new Date('2026-01-01T00:00:00.000Z');
const WABA_CONNECTED = new Date('2026-02-01T00:00:00.000Z');
const INVITE_SENT = new Date('2026-03-01T00:00:00.000Z');
const SECOND_USER = new Date('2026-03-15T00:00:00.000Z');
const BRANDING_CREATED = new Date('2026-04-01T00:00:00.000Z');
const SKIPPED = new Date('2026-05-01T00:00:00.000Z');
const ROW_TOUCHED = new Date('2026-05-02T00:00:00.000Z');

function skipRow(overrides: Partial<OnboardingSkipRow> = {}): OnboardingSkipRow {
  return { stepId: 'set_branding', skippedAt: SKIPPED, updatedAt: ROW_TOUCHED, ...overrides };
}

function factsWith(overrides: Partial<OnboardingFacts> = {}): OnboardingFacts {
  return {
    tenantCreatedAt: TENANT_CREATED,
    completedAt: new Map<OnboardingStepId, Date>(),
    skips: [],
    ...overrides,
  };
}

function statusOf(facts: OnboardingFacts, stepId: OnboardingStepId): OnboardingStep {
  const step = assembleChecklist(TENANT_ID, facts).steps.find((each) => each.id === stepId);

  if (step === undefined) {
    throw new Error(`assembleChecklist omitted ${stepId}, which it may never do.`);
  }

  return step;
}

describe('assembling the checklist from the facts', () => {
  it('serves three pending steps to a tenant with no rows anywhere', () => {
    const checklist = assembleChecklist(TENANT_ID, factsWith());

    // Never a 404, and never a short list: a client that had to tell "missing"
    // from "not started" apart would grow a second empty state for no gain.
    expect(checklist.steps).toEqual([
      { id: 'connect_whatsapp', status: 'pending', completedAt: null, skippedAt: null },
      { id: 'invite_agents', status: 'pending', completedAt: null, skippedAt: null },
      { id: 'set_branding', status: 'pending', completedAt: null, skippedAt: null },
    ]);
    expect(checklist.tenantId).toBe(TENANT_ID);
  });

  it('answers a shape the console can parse, which is where the contract is enforced', () => {
    const parsed = OnboardingChecklistResponseSchema.safeParse(
      assembleChecklist(
        TENANT_ID,
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([['connect_whatsapp', WABA_CONNECTED]]),
          skips: [skipRow()],
        }),
      ),
    );

    expect(parsed.success).toBe(true);
  });

  it('emits the steps in `ONBOARDING_STEP_IDS` order, whatever order the rows came in', () => {
    const checklist = assembleChecklist(
      TENANT_ID,
      factsWith({
        skips: [
          skipRow({ stepId: 'set_branding' }),
          skipRow({ stepId: 'connect_whatsapp' }),
          skipRow({ stepId: 'invite_agents' }),
        ],
      }),
    );

    expect(checklist.steps.map((step) => step.id)).toEqual([
      'connect_whatsapp',
      'invite_agents',
      'set_branding',
    ]);
  });

  it('reports a completed step with the instant the fact became true', () => {
    expect(
      statusOf(
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([['connect_whatsapp', WABA_CONNECTED]]),
        }),
        'connect_whatsapp',
      ),
    ).toEqual({
      id: 'connect_whatsapp',
      status: 'completed',
      completedAt: WABA_CONNECTED.toISOString(),
      skippedAt: null,
    });
  });

  it('lets a completed step beat a skipped one, and clears the skip from the wire', () => {
    // Decision 3. Doing the thing supersedes having put it off — and it is why
    // `reopen` on a completed step is a 200 that changes nothing visible.
    expect(
      statusOf(
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([['set_branding', BRANDING_CREATED]]),
          skips: [skipRow({ stepId: 'set_branding' })],
        }),
        'set_branding',
      ),
    ).toEqual({
      id: 'set_branding',
      status: 'completed',
      completedAt: BRANDING_CREATED.toISOString(),
      skippedAt: null,
    });
  });

  it('treats a row whose `skipped_at` is null as never skipped', () => {
    // What a reopen leaves behind: the row survives so `updatedAt` still moves,
    // but the step is back to pending.
    expect(
      statusOf(
        factsWith({ skips: [skipRow({ stepId: 'invite_agents', skippedAt: null })] }),
        'invite_agents',
      ),
    ).toEqual({ id: 'invite_agents', status: 'pending', completedAt: null, skippedAt: null });
  });

  it('ignores a row naming a step this build does not know', () => {
    // A rollback that reverts the contract but not the data still has to serve a
    // valid response rather than a fourth step the console cannot render.
    const checklist = assembleChecklist(
      TENANT_ID,
      factsWith({ skips: [skipRow({ stepId: 'import_contacts' })] }),
    );

    expect(checklist.steps).toHaveLength(3);
    expect(checklist.steps.every((step) => step.status === 'pending')).toBe(true);
  });

  describe('the checklist’s own timestamps', () => {
    it('holds `completedAt` null while any step is pending', () => {
      const checklist = assembleChecklist(
        TENANT_ID,
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([['connect_whatsapp', WABA_CONNECTED]]),
          skips: [skipRow({ stepId: 'invite_agents' })],
        }),
      );

      expect(checklist.completedAt).toBeNull();
    });

    it('sets it to the latest resolution once every step is resolved, skips included', () => {
      // A skip resolves a step just as a completion does — `onboardingProgress()`
      // counts both, and an admin who skipped branding has finished onboarding.
      const checklist = assembleChecklist(
        TENANT_ID,
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([
            ['connect_whatsapp', WABA_CONNECTED],
            ['invite_agents', INVITE_SENT],
          ]),
          skips: [skipRow({ stepId: 'set_branding', skippedAt: SKIPPED })],
        }),
      );

      expect(checklist.completedAt).toBe(SKIPPED.toISOString());
    });

    it('floors `updatedAt` at the tenant’s own creation, so a new tenant does not churn', () => {
      // `now()` here would make every read return a different value and defeat
      // any client that renders "last updated".
      expect(assembleChecklist(TENANT_ID, factsWith()).updatedAt).toBe(
        TENANT_CREATED.toISOString(),
      );
    });

    it('takes the latest of the resolutions and every row’s `updated_at`', () => {
      const touched = new Date('2026-06-01T00:00:00.000Z');

      const checklist = assembleChecklist(
        TENANT_ID,
        factsWith({
          completedAt: new Map<OnboardingStepId, Date>([['connect_whatsapp', WABA_CONNECTED]]),
          // Reopened: no resolution instant of its own, but the tenant did touch
          // the checklist and `updatedAt` has to say so.
          skips: [skipRow({ stepId: 'invite_agents', skippedAt: null, updatedAt: touched })],
        }),
      );

      expect(checklist.updatedAt).toBe(touched.toISOString());
    });
  });
});

describe('reading the facts', () => {
  /** The five reads `facts` makes, as a stub that records what it was asked. */
  function transactionWith(rows: {
    tenantCreatedAt?: Date | null;
    wabaCreatedAt?: Date | null;
    inviteCreatedAt?: Date | null;
    secondUserCreatedAt?: Date | null;
    brandingCreatedAt?: Date | null;
    skips?: readonly OnboardingSkipRow[];
  }) {
    const findMany = jest.fn().mockImplementation(() => Promise.resolve([...(rows.skips ?? [])]));

    return {
      tx: {
        tenant: {
          findUnique: jest
            .fn()
            .mockResolvedValue(
              rows.tenantCreatedAt === null ? null : { createdAt: rows.tenantCreatedAt },
            ),
        },
        whatsappBusinessAccount: {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _min: { createdAt: rows.wabaCreatedAt ?? null } }),
        },
        invite: {
          aggregate: jest
            .fn()
            .mockResolvedValue({ _min: { createdAt: rows.inviteCreatedAt ?? null } }),
        },
        user: {
          findMany: jest
            .fn()
            .mockResolvedValue(
              rows.secondUserCreatedAt == null ? [] : [{ createdAt: rows.secondUserCreatedAt }],
            ),
        },
        tenantBranding: {
          findFirst: jest
            .fn()
            .mockResolvedValue(
              rows.brandingCreatedAt == null ? null : { createdAt: rows.brandingCreatedAt },
            ),
        },
        tenantOnboardingStep: { findMany },
      } as unknown as Prisma.TransactionClient,
      skipsRead: findMany,
    };
  }

  function readerFor(tx: Prisma.TransactionClient): {
    reader: TenantOnboardingReader;
    ranInTransaction: jest.Mock;
  } {
    const ranInTransaction = jest
      .fn()
      .mockImplementation((work: (client: Prisma.TransactionClient) => unknown) => work(tx));

    return {
      reader: new TenantOnboardingReader({
        $tenantTransaction: ranInTransaction,
      } as unknown as TenantPrisma),
      ranInTransaction,
    };
  }

  it('reads everything in one transaction, so the answers describe one instant', async () => {
    const { tx } = transactionWith({ tenantCreatedAt: TENANT_CREATED });
    const { reader, ranInTransaction } = readerFor(tx);

    await reader.read(TENANT_ID);

    expect(ranInTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses a tenant that is not there rather than inventing an empty checklist', async () => {
    const { tx } = transactionWith({ tenantCreatedAt: null });
    const { reader } = readerFor(tx);

    await expect(reader.read(TENANT_ID)).rejects.toBeInstanceOf(TenantNotFoundError);
  });

  it('completes `connect_whatsapp` on the earliest WABA, not on a registered number', async () => {
    const { tx } = transactionWith({
      tenantCreatedAt: TENANT_CREATED,
      wabaCreatedAt: WABA_CONNECTED,
    });
    const { reader } = readerFor(tx);

    const checklist = await reader.read(TENANT_ID);

    expect(checklist.steps[0]).toEqual({
      id: 'connect_whatsapp',
      status: 'completed',
      completedAt: WABA_CONNECTED.toISOString(),
      skippedAt: null,
    });
  });

  it('completes `invite_agents` on an invite alone', async () => {
    // Any state, revoked included: the admin performed the act, and withdrawing
    // it later is a different decision from never having done it.
    const { tx } = transactionWith({
      tenantCreatedAt: TENANT_CREATED,
      inviteCreatedAt: INVITE_SENT,
    });
    const { reader } = readerFor(tx);

    expect((await reader.read(TENANT_ID)).steps[1]).toEqual({
      id: 'invite_agents',
      status: 'completed',
      completedAt: INVITE_SENT.toISOString(),
      skippedAt: null,
    });
  });

  it('completes `invite_agents` on a second user with no invite at all', async () => {
    // The operator-provisioned tenant whose agents were created directly.
    const { tx } = transactionWith({
      tenantCreatedAt: TENANT_CREATED,
      secondUserCreatedAt: SECOND_USER,
    });
    const { reader } = readerFor(tx);

    expect((await reader.read(TENANT_ID)).steps[1]?.completedAt).toBe(SECOND_USER.toISOString());
  });

  it('takes the earlier of the invite and the second user', async () => {
    const { tx } = transactionWith({
      tenantCreatedAt: TENANT_CREATED,
      inviteCreatedAt: INVITE_SENT,
      secondUserCreatedAt: SECOND_USER,
    });
    const { reader } = readerFor(tx);

    expect((await reader.read(TENANT_ID)).steps[1]?.completedAt).toBe(INVITE_SENT.toISOString());
  });

  it('completes `set_branding` on the branding row’s `created_at`', async () => {
    // `created_at`, not `updated_at`: the latter slides forward on every later
    // edit and turns `completedAt` into "last edited".
    const { tx } = transactionWith({
      tenantCreatedAt: TENANT_CREATED,
      brandingCreatedAt: BRANDING_CREATED,
    });
    const { reader } = readerFor(tx);

    expect((await reader.read(TENANT_ID)).steps[2]?.completedAt).toBe(
      BRANDING_CREATED.toISOString(),
    );
  });

  it('narrows every read to the tenant in scope', async () => {
    const { tx, skipsRead } = transactionWith({ tenantCreatedAt: TENANT_CREATED });
    const { reader } = readerFor(tx);

    await reader.read(TENANT_ID);

    // RLS narrows these tables underneath, but the filter is restated so a
    // mistake is a zero-row read at two layers rather than one.
    expect(skipsRead).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: TENANT_ID } }),
    );
  });
});
