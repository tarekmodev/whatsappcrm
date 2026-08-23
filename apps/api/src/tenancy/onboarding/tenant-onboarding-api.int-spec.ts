import {
  onboardingProgress,
  onboardingStep,
  type OnboardingChecklistResponse,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from '@whatsappcrm/contracts';
import { TenantContextService } from '../../common/tenant-context/tenant-context.service';
import type { PrismaClient } from '../../generated/prisma/client';
import { createPrismaClient } from '../../prisma/prisma-client.factory';
import { withTenantScope, type TenantPrisma } from '../../prisma/tenant-scope.extension';
import { OnboardingStepCompletedError } from './tenant-onboarding.errors';
import { TenantOnboardingReader } from './tenant-onboarding.reader';
import { TenantOnboardingService } from './tenant-onboarding.service';

/**
 * TAR-831's three acceptance criteria against a real PostgreSQL with TAR-48's
 * policies applied, over `whatsappcrm_app` — the role holding no `BYPASSRLS`.
 *
 * A unit test can show that the service calls `upsert`. Only this can show that
 * the skip is actually **durable** — which is the whole of AC2 and AC3 — that
 * `tenant_onboarding_steps` really carries the `tenant_isolation` policy, and
 * that the derivation reads what the four source tables actually hold rather
 * than what a stub was told to say.
 *
 * The four things it proves:
 *
 *   1. a tenant with no rows anywhere loads three `pending` steps, never a 404;
 *   2. a skip survives a reload, and so does a reopen — TAR-831 AC1, AC2, AC3;
 *   3. completion is **derived**: connecting a WABA completes the step without
 *      anything being written to the checklist, and disconnecting it sends the
 *      step back to `pending` with `completedAt` cleared;
 *   4. tenant A's checklist is invisible to tenant B, in both directions.
 *
 * ⚠️ It writes to the database it is pointed at, and commits. Two fixture
 * tenants with fixed ids and a `tar834-fixture` marker, deleted before the run
 * as well as after it, so an interrupted run cleans up on the next one. Point
 * `pnpm test:db` at a local or disposable database.
 *
 * Prerequisites — the four commands in the README, plus `pnpm db:roles:login`:
 *
 *   pnpm db:up && pnpm db:migrate:deploy && pnpm db:roles && pnpm db:roles:login
 */

const TENANT_A = '83400000-0000-7000-8000-000000000801';
const TENANT_B = '83400000-0000-7000-8000-000000000802';
const ADMIN_A = '83400000-0000-7000-8000-0000000008a1';
const ADMIN_B = '83400000-0000-7000-8000-0000000008a2';
const AGENT_A = '83400000-0000-7000-8000-0000000008a3';

const FIXTURE_PREFIX = 'tar834-fixture';
const REQUEST_ID = 'tar834-int-spec';

/** Every step, as the pair the assertions below are written against. */
function statuses(
  checklist: OnboardingChecklistResponse,
): Record<OnboardingStepId, OnboardingStepStatus> {
  return {
    connect_whatsapp: onboardingStep(checklist, 'connect_whatsapp')?.status ?? 'pending',
    invite_agents: onboardingStep(checklist, 'invite_agents')?.status ?? 'pending',
    set_branding: onboardingStep(checklist, 'set_branding')?.status ?? 'pending',
  };
}

describe('the tenant onboarding checklist, end to end', () => {
  const tenantContext = new TenantContextService();

  let systemPrisma: PrismaClient;
  let tenantBase: PrismaClient;
  let tenantPrisma: TenantPrisma;
  let reader: TenantOnboardingReader;
  let onboarding: TenantOnboardingService;

  /** Runs `work` as the pipeline would for `tenantId` and its admin. */
  function asTenant<T>(tenantId: string, userId: string, work: () => Promise<T>): Promise<T> {
    return tenantContext.run({ requestId: REQUEST_ID, tenantId, userId }, async () => await work());
  }

  function readAs(tenantId: string, userId: string): Promise<OnboardingChecklistResponse> {
    return asTenant(tenantId, userId, () => reader.read(tenantId));
  }

  function applyAs(
    tenantId: string,
    userId: string,
    stepId: OnboardingStepId,
    intent: 'skip' | 'reopen',
  ): Promise<OnboardingChecklistResponse> {
    return asTenant(tenantId, userId, () => onboarding.apply({ tenantId, stepId, intent }));
  }

  async function removeFixture(): Promise<void> {
    // Every fixture table cascades from the tenant, so one delete is enough and
    // stays correct as the schema grows.
    await systemPrisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B] } } });
    // The WABA id is globally unique, so a failed run would otherwise hold it.
    await systemPrisma.whatsappBusinessAccount.deleteMany({
      where: { wabaId: { startsWith: FIXTURE_PREFIX } },
    });
  }

  beforeAll(() => {
    systemPrisma = createPrismaClient('system', requireEnv('SYSTEM_DATABASE_URL'));
    tenantBase = createPrismaClient('tenant', requireEnv('APP_DATABASE_URL'));
    tenantPrisma = withTenantScope(tenantBase, tenantContext);

    reader = new TenantOnboardingReader(tenantPrisma);
    onboarding = new TenantOnboardingService(tenantPrisma, reader, tenantContext);
  });

  afterAll(async () => {
    await removeFixture();
    await Promise.all([systemPrisma.$disconnect(), tenantBase.$disconnect()]);
  });

  beforeEach(async () => {
    await removeFixture();
    await systemPrisma.tenant.createMany({
      data: [
        { id: TENANT_A, slug: `${FIXTURE_PREFIX}-a`, name: 'TAR-834 tenant A', status: 'active' },
        { id: TENANT_B, slug: `${FIXTURE_PREFIX}-b`, name: 'TAR-834 tenant B', status: 'active' },
      ],
    });
    // One user each — the founding admin. A second one would complete
    // `invite_agents` before any case had asked for it.
    await systemPrisma.user.createMany({
      data: [
        {
          id: ADMIN_A,
          tenantId: TENANT_A,
          email: `admin@${FIXTURE_PREFIX}-a.test`,
          name: 'Avery A',
          role: 'admin',
          status: 'active',
        },
        {
          id: ADMIN_B,
          tenantId: TENANT_B,
          email: `admin@${FIXTURE_PREFIX}-b.test`,
          name: 'Avery B',
          role: 'admin',
          status: 'active',
        },
      ],
    });
  });

  describe('the first load', () => {
    it('gives a tenant with no rows anywhere three pending steps', async () => {
      const checklist = await readAs(TENANT_A, ADMIN_A);

      expect(checklist.tenantId).toBe(TENANT_A);
      expect(statuses(checklist)).toEqual({
        connect_whatsapp: 'pending',
        invite_agents: 'pending',
        set_branding: 'pending',
      });
      expect(checklist.completedAt).toBeNull();
    });

    it('needs nothing backfilled — no checklist row exists yet', async () => {
      await readAs(TENANT_A, ADMIN_A);

      // Decision 1: the read writes nothing. A tenant provisioned before this
      // shipped gets a correct checklist without a migration having touched it.
      await expect(
        systemPrisma.tenantOnboardingStep.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(0);
    });
  });

  describe('skipping, and coming back later', () => {
    it('persists a skip and still reports it on a fresh read', async () => {
      // TAR-831 AC1 and AC2: the state survives the request that set it.
      const written = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      expect(onboardingStep(written, 'set_branding')?.status).toBe('skipped');

      const reloaded = await readAs(TENANT_A, ADMIN_A);

      expect(onboardingStep(reloaded, 'set_branding')).toEqual(
        onboardingStep(written, 'set_branding'),
      );
    });

    it('reflects several skips when the admin returns', async () => {
      // TAR-831 AC3.
      await applyAs(TENANT_A, ADMIN_A, 'connect_whatsapp', 'skip');
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      expect(statuses(await readAs(TENANT_A, ADMIN_A))).toEqual({
        connect_whatsapp: 'skipped',
        invite_agents: 'pending',
        set_branding: 'skipped',
      });
    });

    it('records who put it off, and never puts them on the wire', async () => {
      const checklist = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      const row = await systemPrisma.tenantOnboardingStep.findFirstOrThrow({
        where: { tenantId: TENANT_A, stepId: 'set_branding' },
      });

      expect(row.skippedByUserId).toBe(ADMIN_A);
      expect(JSON.stringify(checklist)).not.toContain(ADMIN_A);
    });

    it('does not rewrite `skipped_at` when the same skip arrives twice', async () => {
      const first = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');
      const second = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      // Two tabs racing the same button must not churn the checklist's own
      // `updatedAt`, which a client renders as "last changed".
      expect(second.updatedAt).toBe(first.updatedAt);
      expect(onboardingStep(second, 'set_branding')?.skippedAt).toBe(
        onboardingStep(first, 'set_branding')?.skippedAt,
      );
    });

    it('reopens a skipped step and keeps the row so `updatedAt` still moves', async () => {
      const skipped = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');
      const reopened = await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'reopen');

      expect(onboardingStep(reopened, 'set_branding')).toEqual({
        id: 'set_branding',
        status: 'pending',
        completedAt: null,
        skippedAt: null,
      });
      expect(new Date(reopened.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(skipped.updatedAt).getTime(),
      );

      const row = await systemPrisma.tenantOnboardingStep.findFirstOrThrow({
        where: { tenantId: TENANT_A, stepId: 'set_branding' },
      });

      // Kept, with `skipped_at` cleared: "was this ever skipped, and by whom"
      // stays answerable for support.
      expect(row.skippedAt).toBeNull();
      expect(row.skippedByUserId).toBe(ADMIN_A);
    });

    it('re-skips a reopened step into the same row', async () => {
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'reopen');
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      // `(tenant_id, step_id)` is unique, so this can only ever be one row.
      await expect(
        systemPrisma.tenantOnboardingStep.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(1);
      expect(statuses(await readAs(TENANT_A, ADMIN_A)).set_branding).toBe('skipped');
    });

    it('treats a reopen of a step never skipped as a no-op, writing nothing', async () => {
      await applyAs(TENANT_A, ADMIN_A, 'invite_agents', 'reopen');

      await expect(
        systemPrisma.tenantOnboardingStep.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(0);
    });
  });

  describe('completion, derived from the tenant’s own rows', () => {
    it('completes `connect_whatsapp` when a WABA appears, with nothing written', async () => {
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });

      const checklist = await readAs(TENANT_A, ADMIN_A);

      expect(onboardingStep(checklist, 'connect_whatsapp')?.status).toBe('completed');
      await expect(
        systemPrisma.tenantOnboardingStep.count({ where: { tenantId: TENANT_A } }),
      ).resolves.toBe(0);
    });

    it('sends the step back to pending when the WABA is disconnected', async () => {
      // The reason derivation was chosen over a materialised status column: a
      // checklist describing a workspace that no longer exists is the failure a
      // missed reverse-hook produces, and there is no hook here to miss.
      const waba = await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'connect_whatsapp')?.status).toBe(
        'completed',
      );

      await systemPrisma.whatsappBusinessAccount.delete({ where: { id: waba.id } });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'connect_whatsapp')).toEqual({
        id: 'connect_whatsapp',
        status: 'pending',
        completedAt: null,
        skippedAt: null,
      });
    });

    it('completes `invite_agents` on a revoked invite', async () => {
      await systemPrisma.invite.create({
        data: {
          tenantId: TENANT_A,
          email: `agent@${FIXTURE_PREFIX}-a.test`,
          tokenHash: `${FIXTURE_PREFIX}-token-a`,
          expiresAt: new Date('2027-01-01T00:00:00.000Z'),
          revokedAt: new Date(),
        },
      });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'invite_agents')?.status).toBe(
        'completed',
      );
    });

    it('completes `invite_agents` on a second user with no invite at all', async () => {
      await systemPrisma.user.create({
        data: {
          id: AGENT_A,
          tenantId: TENANT_A,
          email: `agent@${FIXTURE_PREFIX}-a.test`,
          name: 'Ada Agent',
          role: 'agent',
          status: 'active',
        },
      });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'invite_agents')?.status).toBe(
        'completed',
      );
    });

    it('leaves `set_branding` pending for a branding row with every field null', async () => {
      // Belt and braces against a future default seed: the row's existence alone
      // must not claim the admin has been near the branding screen.
      await systemPrisma.tenantBranding.create({ data: { tenantId: TENANT_A } });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'set_branding')?.status).toBe(
        'pending',
      );
    });

    it('completes `set_branding` on the row’s `created_at`, not a later edit', async () => {
      const created = await systemPrisma.tenantBranding.create({
        data: { tenantId: TENANT_A, productName: 'Fixture CRM' },
      });

      await systemPrisma.tenantBranding.update({
        where: { tenantId: TENANT_A },
        data: { primaryColor: '#123456' },
      });

      const step = onboardingStep(await readAs(TENANT_A, ADMIN_A), 'set_branding');

      expect(step?.status).toBe('completed');
      expect(step?.completedAt).toBe(created.createdAt.toISOString());
    });

    it('lets a completed step beat a skipped one', async () => {
      await applyAs(TENANT_A, ADMIN_A, 'connect_whatsapp', 'skip');
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });

      const step = onboardingStep(await readAs(TENANT_A, ADMIN_A), 'connect_whatsapp');

      expect(step?.status).toBe('completed');
      expect(step?.skippedAt).toBeNull();
    });

    it('refuses a skip of a completed step', async () => {
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });

      await expect(applyAs(TENANT_A, ADMIN_A, 'connect_whatsapp', 'skip')).rejects.toBeInstanceOf(
        OnboardingStepCompletedError,
      );
    });

    it('answers a reopen of a completed step with 200 and no visible change', async () => {
      // Divergence 3: the mock resets any reopen to `pending`; the real API
      // cannot, because completion is derived and there is nothing to un-derive.
      await applyAs(TENANT_A, ADMIN_A, 'connect_whatsapp', 'skip');
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });

      const reopened = await applyAs(TENANT_A, ADMIN_A, 'connect_whatsapp', 'reopen');

      expect(onboardingStep(reopened, 'connect_whatsapp')?.status).toBe('completed');

      const row = await systemPrisma.tenantOnboardingStep.findFirstOrThrow({
        where: { tenantId: TENANT_A, stepId: 'connect_whatsapp' },
      });

      expect(row.skippedAt).toBeNull();
    });

    it('fills `completedAt` once every step is resolved, skips included', async () => {
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_A, wabaId: `${FIXTURE_PREFIX}-waba-a`, name: 'Fixture WABA' },
      });
      await systemPrisma.tenantBranding.create({
        data: { tenantId: TENANT_A, productName: 'Fixture CRM' },
      });
      const checklist = await applyAs(TENANT_A, ADMIN_A, 'invite_agents', 'skip');

      expect(onboardingProgress(checklist)).toEqual({
        completed: 2,
        skipped: 1,
        resolved: 3,
        total: 3,
        isComplete: true,
      });
      expect(checklist.completedAt).not.toBeNull();
    });
  });

  describe('isolation between two tenants', () => {
    it('keeps one tenant’s skips out of the other’s checklist', async () => {
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      expect(statuses(await readAs(TENANT_B, ADMIN_B))).toEqual({
        connect_whatsapp: 'pending',
        invite_agents: 'pending',
        set_branding: 'pending',
      });
    });

    it('keeps one tenant’s completions out of the other’s checklist', async () => {
      await systemPrisma.whatsappBusinessAccount.create({
        data: { tenantId: TENANT_B, wabaId: `${FIXTURE_PREFIX}-waba-b`, name: 'Fixture WABA B' },
      });

      expect(onboardingStep(await readAs(TENANT_A, ADMIN_A), 'connect_whatsapp')?.status).toBe(
        'pending',
      );
      expect(onboardingStep(await readAs(TENANT_B, ADMIN_B), 'connect_whatsapp')?.status).toBe(
        'completed',
      );
    });

    it('cannot be made to read another tenant’s rows over the tenant connection', async () => {
      await applyAs(TENANT_A, ADMIN_A, 'set_branding', 'skip');

      // The policy, not the `where`: this asks for tenant A's row from inside
      // tenant B's scope and must see nothing.
      const leaked = await asTenant(TENANT_B, ADMIN_B, () =>
        tenantPrisma.tenantOnboardingStep.findMany({ where: { tenantId: TENANT_A } }),
      );

      expect(leaked).toEqual([]);
    });

    it('answers each tenant with its own id, taken from the scope', async () => {
      await expect(readAs(TENANT_A, ADMIN_A)).resolves.toMatchObject({ tenantId: TENANT_A });
      await expect(readAs(TENANT_B, ADMIN_B)).resolves.toMatchObject({ tenantId: TENANT_B });
    });
  });
});

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
